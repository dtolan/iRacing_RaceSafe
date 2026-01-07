import * as dotenv from 'dotenv';
import * as irsdk from 'iracing-sdk-js';
import { exec } from 'child_process';
import { IRacingClient } from '../api/iracingClient';
import { analyzeDriver } from '../analysis/riskAnalysis';
import { DriverRiskProfile } from '../types';
import logger, { initLogger, setConsoleOutput } from '../utils/logger';

dotenv.config();

// ============================================================================
// Configuration
// ============================================================================

interface AlertConfig {
  practice: { danger: boolean; incident: boolean };
  qualify: { danger: boolean; incident: boolean };
  race: { danger: boolean; incident: boolean };
  warmup: { danger: boolean; incident: boolean };
}

const alertConfig: AlertConfig = {
  practice: {
    danger: process.env.ALERTS_PRACTICE_DANGER?.toLowerCase() !== 'off',
    incident: process.env.ALERTS_PRACTICE_INCIDENT?.toLowerCase() !== 'off',
  },
  qualify: {
    danger: process.env.ALERTS_QUALIFY_DANGER?.toLowerCase() !== 'off',
    incident: process.env.ALERTS_QUALIFY_INCIDENT?.toLowerCase() !== 'off',
  },
  race: {
    danger: process.env.ALERTS_RACE_DANGER?.toLowerCase() !== 'off',
    incident: process.env.ALERTS_RACE_INCIDENT?.toLowerCase() !== 'off',
  },
  warmup: {
    danger: process.env.ALERTS_WARMUP_DANGER?.toLowerCase() !== 'off',
    incident: process.env.ALERTS_WARMUP_INCIDENT?.toLowerCase() !== 'off',
  },
};

// Service control
let isRunning = true;
let isServiceMode = false;

// ============================================================================
// Audio Alert System
// ============================================================================

type AlertType = 'danger' | 'warning' | 'incident' | 'clear';

/**
 * Play audio alerts using Windows system sounds
 * Falls back to console beep if PowerShell fails
 * Respects session type configuration
 */
function playAlert(type: AlertType): void {
  // Check if alert is enabled for current session type
  const sessionConfig = alertConfig[currentSessionType] || alertConfig.race;
  if (type === 'danger' && !sessionConfig.danger) return;
  if (type === 'incident' && !sessionConfig.incident) return;

  try {
    // Use PowerShell to play Windows system sounds
    // These are non-blocking and don't require external dependencies
    let command: string;

    switch (type) {
      case 'danger':
        // Critical alert - play exclamation sound twice for urgency
        command = `powershell -Command "[System.Media.SystemSounds]::Exclamation.Play(); Start-Sleep -Milliseconds 300; [System.Media.SystemSounds]::Exclamation.Play()"`;
        break;
      case 'warning':
        // Moderate warning - single beep
        command = `powershell -Command "[System.Media.SystemSounds]::Beep.Play()"`;
        break;
      case 'incident':
        // You got an incident - asterisk sound
        command = `powershell -Command "[System.Media.SystemSounds]::Asterisk.Play()"`;
        break;
      case 'clear':
        // Danger cleared - subtle chime (not implemented, just skip)
        return;
      default:
        return;
    }

    // Execute asynchronously so it doesn't block telemetry processing
    exec(command);
  } catch (e) {
    // Fallback to console bell
    if (!isServiceMode) {
      process.stdout.write('\x07');
    }
  }
}

const myCustId = parseInt(process.env.IRACING_CUST_ID || '0');

// ============================================================================
// Types
// ============================================================================

interface SessionDriver {
  carIdx: number;
  custId: number;
  name: string;
  iRating: number;
  licenseLevel: string;
  carNumber: string;
}

interface IncidentTypes {
  contact4x: number;
  lostControl2x: number;
  offTrack1x: number;
  total: number;
}

interface AnalyzedDriver {
  carIdx: number;
  carNumber: string;
  custId: number;
  name: string;
  sr: string;
  licenseClass: string;
  iRating: number;
  totalRaces: number;
  recentRaces: number;
  avgIncidents: number;
  recentAvgIncidents: number;
  lastRaceIncidents: number;
  incidentTypes: IncidentTypes;
  riskScore: number;
  riskLevel: string;
  patterns: string[];
  isMe: boolean;
}

interface FieldStats {
  sof: number;
  licenseBreakdown: { [key: string]: number };
  avgSR: number;
  rookieCount: number;
}

interface NearbyDriver {
  driver: AnalyzedDriver;
  gap: number;
  direction: 'AHEAD' | 'BEHIND';
  sessionIncidents: number; // Their incidents THIS race
}

// ============================================================================
// Global State
// ============================================================================

let client: IRacingClient | null = null;
let authenticated = false;
let sessionDrivers: Map<number, SessionDriver> = new Map();
let analyzedDrivers: Map<number, AnalyzedDriver> = new Map(); // keyed by carIdx
let myCarIdx = -1;

// Session state
type SessionPhase = 'WAITING' | 'CONNECTING' | 'PRE_RACE' | 'RACING' | 'POST_RACE';
let currentPhase: SessionPhase = 'WAITING';
let preRaceAnalysisComplete = false;

// Session type detection (Practice, Qualify, Race, Warmup)
type SessionType = 'practice' | 'qualify' | 'race' | 'warmup';
let currentSessionType: SessionType = 'race';

// Alert state - track which drivers are currently in the danger zone
// Only alert when a HIGH risk driver ENTERS the zone, not while they stay
let driversInDangerZone: Set<number> = new Set(); // carIdx of drivers currently within alert range
const DANGER_ZONE_THRESHOLD = 1.5; // seconds - alert when entering this range

// Token refresh interval (refresh every 10 minutes to stay ahead of 15-min expiry)
let tokenRefreshInterval: NodeJS.Timeout | null = null;
const TOKEN_REFRESH_INTERVAL = 10 * 60 * 1000; // 10 minutes

// Track info
let trackName = '';
let seriesName = '';

// In-race incident tracking
let mySessionIncidents = 0;
let lastKnownIncidents = -1; // -1 means not initialized

// Track all drivers' session incidents (carIdx -> incident count)
let driverSessionIncidents: Map<number, number> = new Map();

// SDK instance reference for cleanup
let iracingSDK: any = null;

// ============================================================================
// State Reset (for persistent operation)
// ============================================================================

/**
 * Reset all session state between iRacing connections
 * Called when disconnecting to prepare for next session
 */
function resetSessionState(): void {
  logger.info('Resetting session state for next connection');

  // Clear driver data
  sessionDrivers = new Map();
  analyzedDrivers = new Map();
  driverSessionIncidents = new Map();
  driversInDangerZone = new Set();

  // Reset session tracking
  myCarIdx = -1;
  currentPhase = 'WAITING';
  currentSessionType = 'race';
  preRaceAnalysisComplete = false;

  // Reset track info
  trackName = '';
  seriesName = '';

  // Reset incident tracking
  mySessionIncidents = 0;
  lastKnownIncidents = -1;

  // Clear token refresh (will restart on next connection)
  if (tokenRefreshInterval) {
    clearInterval(tokenRefreshInterval);
    tokenRefreshInterval = null;
  }

  // Note: Keep client and authenticated state - reuse API connection
}

// ============================================================================
// Main Entry Point
// ============================================================================

/**
 * Run a single monitoring session
 * Returns when iRacing disconnects
 */
async function runSession(): Promise<void> {
  return new Promise((resolve, reject) => {
    output('='.repeat(100));
    output('                                    RACESAFE');
    output('                       Pre-Race Analysis + In-Race Monitor');
    output('='.repeat(100));
    output('\nConnecting to iRacing...');

    currentPhase = 'CONNECTING';

    // Initialize iRacing SDK
    iracingSDK = irsdk.init({
      telemetryUpdateInterval: 500,
      sessionInfoUpdateInterval: 2000,
    });

    let connectionTimeout: NodeJS.Timeout | null = null;

    // Handle connection
    iracingSDK.on('Connected', async () => {
      if (connectionTimeout) {
        clearTimeout(connectionTimeout);
        connectionTimeout = null;
      }

      output('Connected to iRacing simulator!');
      logger.info('Connected to iRacing simulator');
      currentPhase = 'PRE_RACE';

      // Authenticate with iRacing API if not already authenticated
      if (!authenticated || !client) {
        client = new IRacingClient();
        const email = process.env.IRACING_EMAIL!;
        const password = process.env.IRACING_PASSWORD!;
        const clientId = process.env.IRACING_CLIENT_ID!;
        const clientSecret = process.env.IRACING_CLIENT_SECRET!;

        try {
          await client.authenticate(email, password, clientId, clientSecret);
          authenticated = true;
          logger.info('Authenticated with iRacing API');

          // Start proactive token refresh timer
          tokenRefreshInterval = setInterval(async () => {
            if (client && authenticated) {
              const refreshed = await client.refreshAccessToken();
              if (!refreshed) {
                logger.warn('Token refresh failed - API calls may fail');
              }
            }
          }, TOKEN_REFRESH_INTERVAL);

        } catch (error) {
          logger.warn('Could not authenticate with iRacing API - running without detailed profiles');
          output('Warning: Could not authenticate with iRacing API');
          output('Running without detailed risk profiles\n');
        }
      }

      // If we already have drivers, run analysis now
      if (sessionDrivers.size > 0 && !preRaceAnalysisComplete && currentPhase === 'PRE_RACE' && authenticated) {
        await runPreRaceAnalysis();
      }
    });

    iracingSDK.on('Disconnected', () => {
      output('\nDisconnected from iRacing.');
      logger.info('Disconnected from iRacing simulator');
      resolve(); // Resolve promise to continue main loop
    });

    // Handle session info updates
    iracingSDK.on('SessionInfo', async (evt: any) => {
      await handleSessionInfo(evt.data);
    });

    // Handle telemetry updates (for in-race monitoring)
    iracingSDK.on('Telemetry', (evt: any) => {
      if (currentPhase === 'RACING') {
        handleTelemetry(evt.values);
      }
    });

    // Timeout if no connection (only in non-persistent mode)
    connectionTimeout = setTimeout(() => {
      if (currentPhase === 'CONNECTING') {
        if (isServiceMode) {
          // In service mode, just resolve and let main loop retry
          logger.info('No iRacing connection - will retry...');
          resolve();
        } else {
          output('\nTimeout: Could not connect to iRacing.');
          output('Make sure iRacing is running and you are in a session.');
          reject(new Error('Connection timeout'));
        }
      }
    }, 10000);

    output('\nWaiting for session data...');
  });
}

/**
 * Main persistent loop for service mode
 * Continuously monitors iRacing, reconnecting as needed
 */
async function runServiceLoop(): Promise<void> {
  logger.info('Starting RaceSafe service loop');

  while (isRunning) {
    try {
      await runSession();
    } catch (error) {
      logger.error('Session error', error);
    }

    // Reset state for next session
    resetSessionState();

    if (isRunning) {
      logger.info('Waiting 5 seconds before reconnecting...');
      await delay(5000);
    }
  }

  logger.info('RaceSafe service loop stopped');
}

/**
 * Legacy entry point for standalone operation
 */
async function racesafe(): Promise<void> {
  try {
    await runSession();
  } catch (error) {
    process.exit(1);
  }
  process.exit(0);
}

/**
 * Start RaceSafe in service mode (persistent, auto-reconnect)
 */
export async function startService(): Promise<void> {
  isServiceMode = true;
  initLogger({ consoleOutput: false }); // Log to file only
  setConsoleOutput(false);

  // Handle graceful shutdown
  process.on('SIGTERM', () => {
    logger.info('Received SIGTERM - shutting down');
    isRunning = false;
  });
  process.on('SIGINT', () => {
    logger.info('Received SIGINT - shutting down');
    isRunning = false;
  });

  await runServiceLoop();
}

/**
 * Stop the service gracefully
 */
export function stopService(): void {
  logger.info('Stop requested');
  isRunning = false;
}

// Helper functions
function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function output(message: string): void {
  if (isServiceMode) {
    logger.info(message);
  } else {
    console.log(message);
  }
}

// ============================================================================
// Session Info Handler
// ============================================================================

async function handleSessionInfo(sessionInfo: any) {
  // Extract track/series info
  const weekendInfo = sessionInfo.WeekendInfo;
  if (weekendInfo) {
    trackName = weekendInfo.TrackDisplayName || weekendInfo.TrackName || '';
    seriesName = weekendInfo.SeriesID ? `Series ${weekendInfo.SeriesID}` : '';
  }

  // Detect session type (Practice, Qualify, Race, Warmup)
  const sessions = sessionInfo.SessionInfo?.Sessions;
  if (sessions && Array.isArray(sessions)) {
    // Find the active session or use the last one
    for (const session of sessions) {
      const sessionType = session.SessionType?.toLowerCase() || '';
      if (sessionType.includes('practice') || sessionType.includes('open')) {
        currentSessionType = 'practice';
      } else if (sessionType.includes('qualify') || sessionType.includes('lone')) {
        currentSessionType = 'qualify';
      } else if (sessionType.includes('race')) {
        currentSessionType = 'race';
      } else if (sessionType.includes('warmup')) {
        currentSessionType = 'warmup';
      }
    }
  }

  // Extract driver info
  const driverInfo = sessionInfo.DriverInfo;
  if (!driverInfo?.Drivers) return;

  // Build/update driver map
  for (const d of driverInfo.Drivers) {
    if (!d.UserName || d.UserName === 'Pace Car') continue;

    sessionDrivers.set(d.CarIdx, {
      carIdx: d.CarIdx,
      custId: d.UserID,
      name: d.UserName,
      iRating: d.IRating || 0,
      licenseLevel: d.LicString || 'Unknown',
      carNumber: d.CarNumber || d.CarIdx.toString(),
    });

    if (d.UserID === myCustId) {
      myCarIdx = d.CarIdx;
    }
  }

  // Extract live incident counts from session results
  // SessionInfo.SessionInfo.Sessions[].ResultsPositions[] contains per-driver incidents
  const sessionsList = sessionInfo.SessionInfo?.Sessions;
  if (sessionsList && Array.isArray(sessionsList)) {
    // Find the race session (usually the last one, or look for SessionType === 'Race')
    for (const sess of sessionsList) {
      if (sess.ResultsPositions && Array.isArray(sess.ResultsPositions)) {
        for (const result of sess.ResultsPositions) {
          const carIdx = result.CarIdx;
          const incidents = result.Incidents ?? 0;
          driverSessionIncidents.set(carIdx, incidents);
        }
      }
    }
  }

  // Run pre-race analysis once we have drivers and are authenticated
  if (sessionDrivers.size > 0 && !preRaceAnalysisComplete && currentPhase === 'PRE_RACE' && authenticated) {
    await runPreRaceAnalysis();
  }
}

// ============================================================================
// Pre-Race Analysis
// ============================================================================

async function runPreRaceAnalysis() {
  if (preRaceAnalysisComplete) return;
  preRaceAnalysisComplete = true;

  // Wait for authentication to complete (max 5 seconds)
  let waitCount = 0;
  while (!authenticated && client && waitCount < 50) {
    await new Promise(resolve => setTimeout(resolve, 100));
    waitCount++;
  }

  const sessionTypeDisplay = currentSessionType.charAt(0).toUpperCase() + currentSessionType.slice(1);
  output('\n' + '='.repeat(100));
  output(`                                  ${sessionTypeDisplay.toUpperCase()} SESSION ANALYSIS`);
  output('='.repeat(100));
  output(`\nTrack: ${trackName}`);
  output(`Session Type: ${sessionTypeDisplay}`);
  output(`Drivers in session: ${sessionDrivers.size}`);
  output('\nFetching driver risk profiles...\n');

  logger.info(`Starting analysis for ${sessionTypeDisplay} session at ${trackName}`);

  // Convert to array and sort by car number
  const drivers = Array.from(sessionDrivers.values());
  drivers.sort((a, b) => {
    const numA = parseInt(a.carNumber) || 999;
    const numB = parseInt(b.carNumber) || 999;
    return numA - numB;
  });

  // Analyze all drivers
  const analyses = await processDriversInParallel(drivers);

  // Store in map for quick lookup during race
  for (const analysis of analyses) {
    analyzedDrivers.set(analysis.carIdx, analysis);
  }

  // Print analysis
  printDriverTable(analyses);
  printSummary(analyses);

  // Transition to race monitoring
  console.log('\n' + '='.repeat(100));
  console.log('                              WAITING FOR RACE START');
  console.log('='.repeat(100));
  console.log('\nMonitoring will begin when green flag drops...');
  console.log('Press Ctrl+C to exit.\n');

  currentPhase = 'RACING';
}

// ============================================================================
// In-Race Telemetry Handler
// ============================================================================

function handleTelemetry(telemetry: any) {
  if (myCarIdx === -1 || analyzedDrivers.size === 0) return;

  // Check session state - only monitor during race
  const sessionFlags = telemetry.SessionFlags || 0;
  const isGreen = (sessionFlags & 0x4) !== 0; // Green flag
  const isCheckered = (sessionFlags & 0x8) !== 0;

  if (isCheckered) {
    if (currentPhase !== 'POST_RACE') {
      currentPhase = 'POST_RACE';
      console.log('\n\n' + '='.repeat(60));
      console.log('                   CHECKERED FLAG!');
      console.log('='.repeat(60));
      console.log(`\n  Your session incidents: ${mySessionIncidents}x`);
      if (mySessionIncidents === 0) {
        console.log('  \x1b[32mPerfect race - no incidents!\x1b[0m');
      } else if (mySessionIncidents <= 4) {
        console.log('  \x1b[32mClean race - well done!\x1b[0m');
      } else if (mySessionIncidents <= 8) {
        console.log('  \x1b[33mRoom for improvement\x1b[0m');
      } else {
        console.log('  \x1b[31mRough race - review what went wrong\x1b[0m');
      }
      console.log('\n' + '='.repeat(60));
    }
    return;
  }

  // Get position data
  const carIdxLap = telemetry.CarIdxLap || [];
  const carIdxLapDistPct = telemetry.CarIdxLapDistPct || [];
  const carIdxPosition = telemetry.CarIdxPosition || [];
  const carIdxClassPosition = telemetry.CarIdxClassPosition || [];
  const carIdxOnPitRoad = telemetry.CarIdxOnPitRoad || [];

  // Get per-driver session incidents (from session results data if available)
  // Note: SessionInfo contains ResultsPositions with incident counts per driver
  // We'll update this from SessionInfo handler, but telemetry might have it too

  // Track my incidents - PlayerCarMyIncidentCount is direct incident count for player
  const myIncidents = telemetry.PlayerCarMyIncidentCount ?? 0;
  if (lastKnownIncidents === -1) {
    // Initialize on first read
    lastKnownIncidents = myIncidents;
    mySessionIncidents = 0;
  } else if (myIncidents > lastKnownIncidents) {
    // New incident occurred
    const newIncidents = myIncidents - lastKnownIncidents;
    mySessionIncidents += newIncidents;
    lastKnownIncidents = myIncidents;
    // Play audio alert for incident
    playAlert('incident');
    // Flash alert for new incident
    console.log(`\n\x1b[43m\x1b[30m +${newIncidents}x INCIDENT \x1b[0m (Session total: ${mySessionIncidents}x)`);
  }

  // Get my position
  const myLapDistPct = carIdxLapDistPct[myCarIdx] || 0;
  const myPosition = carIdxClassPosition[myCarIdx] || 0;
  const myLap = carIdxLap[myCarIdx] || 0;

  if (myLap < 0) return; // Not on track

  // Find nearby drivers
  const nearby: NearbyDriver[] = [];

  for (const [carIdx, analysis] of analyzedDrivers) {
    if (carIdx === myCarIdx) continue;
    if (carIdxLap[carIdx] < 0) continue; // Not on track
    if (carIdxOnPitRoad[carIdx]) continue; // In pits

    // Calculate track gap
    let trackGap = carIdxLapDistPct[carIdx] - myLapDistPct;
    if (trackGap > 0.5) trackGap -= 1;
    if (trackGap < -0.5) trackGap += 1;

    // Convert to approximate seconds
    const avgLapTime = 90; // Could get from telemetry
    const gapSeconds = Math.abs(trackGap * avgLapTime);

    if (gapSeconds > 5) continue;

    // Get their current session incident count
    const sessionInc = driverSessionIncidents.get(carIdx) ?? 0;

    nearby.push({
      driver: analysis,
      gap: gapSeconds,
      direction: trackGap > 0 ? 'AHEAD' : 'BEHIND',
      sessionIncidents: sessionInc,
    });
  }

  // Sort by gap
  nearby.sort((a, b) => a.gap - b.gap);

  // Display status
  displayRaceStatus(myPosition, myLap, nearby, analyzedDrivers.size, mySessionIncidents);
}

// ============================================================================
// Race Status Display
// ============================================================================

function displayRaceStatus(position: number, lap: number, nearby: NearbyDriver[], totalCars: number, incidents: number) {
  // Clear line and write status
  process.stdout.write('\r\x1b[K');

  const closestAhead = nearby.find(n => n.direction === 'AHEAD');
  const closestBehind = nearby.find(n => n.direction === 'BEHIND');

  // Color incidents based on count
  let incidentColor = '\x1b[32m'; // Green for 0-3
  if (incidents >= 8) {
    incidentColor = '\x1b[31m'; // Red for 8+
  } else if (incidents >= 4) {
    incidentColor = '\x1b[33m'; // Yellow for 4-7
  }

  let statusLine = `Lap ${lap} | P${position}/${totalCars} | ${incidentColor}${incidents}x\x1b[0m | `;

  // Ahead
  if (closestAhead) {
    const color = getThreatColor(closestAhead.driver.riskLevel);
    const blink = closestAhead.gap < 1.5 ? '\x1b[5m' : '';
    const reset = closestAhead.gap < 1.5 ? '\x1b[25m' : '';
    const sessInc = formatSessionIncidents(closestAhead.sessionIncidents);
    statusLine += `${color}${blink}↑${reset} #${closestAhead.driver.carNumber} ${closestAhead.gap.toFixed(1)}s ${sessInc} [${closestAhead.driver.riskLevel}]\x1b[0m | `;
  } else {
    statusLine += '↑ Clear | ';
  }

  // Behind
  if (closestBehind) {
    const color = getThreatColor(closestBehind.driver.riskLevel);
    const blink = closestBehind.gap < 1.5 ? '\x1b[5m' : '';
    const reset = closestBehind.gap < 1.5 ? '\x1b[25m' : '';
    const sessInc = formatSessionIncidents(closestBehind.sessionIncidents);
    statusLine += `${color}${blink}↓${reset} #${closestBehind.driver.carNumber} ${closestBehind.gap.toFixed(1)}s ${sessInc} [${closestBehind.driver.riskLevel}]\x1b[0m`;
  } else {
    statusLine += '↓ Clear';
  }

  process.stdout.write(statusLine);

  // Alert logic: only alert when HIGH risk driver ENTERS danger zone
  // Once they leave (gap > threshold), they can trigger again if they return
  const highRiskNearby = nearby.filter(n => n.driver.riskLevel === 'HIGH');

  // Find drivers currently in danger zone
  const currentlyInZone = new Set<number>();
  for (const threat of highRiskNearby) {
    if (threat.gap < DANGER_ZONE_THRESHOLD) {
      currentlyInZone.add(threat.driver.carIdx);

      // Alert only if they just entered (weren't in zone before)
      if (!driversInDangerZone.has(threat.driver.carIdx)) {
        // Play audio alert for HIGH risk driver entering danger zone
        playAlert('danger');

        console.log('');
        // Include their session incidents - shows if they're having a rough race
        const sessIncStr = threat.sessionIncidents > 0
          ? ` - ${threat.sessionIncidents}x this race`
          : ' - clean so far';
        const recklessWarning = threat.sessionIncidents >= 6
          ? ' ⚠ RECKLESS TODAY!'
          : '';
        // Show car number, risk level, incident stats - but NOT driver name
        console.log(`\x1b[41m\x1b[37m ⚠ DANGER: #${threat.driver.carNumber} ${threat.direction} - HIGH RISK (${threat.driver.avgIncidents} avg inc/race)${sessIncStr}${recklessWarning} \x1b[0m`);
        if (threat.driver.patterns.length > 0) {
          console.log(`   ${threat.driver.patterns[0]}`);
        }
      }
    }
  }

  // Update the tracking set - remove drivers who left, add those who entered
  driversInDangerZone.clear();
  for (const carIdx of currentlyInZone) {
    driversInDangerZone.add(carIdx);
  }
}

function getThreatColor(level: string): string {
  switch (level) {
    case 'HIGH': return '\x1b[31m';
    case 'MODERATE': return '\x1b[33m';
    case 'LOW': return '\x1b[32m';
    default: return '\x1b[37m';
  }
}

/**
 * Format session incidents with color coding
 * Shows how reckless they're being THIS race
 */
function formatSessionIncidents(inc: number): string {
  if (inc >= 8) {
    return `\x1b[31m(${inc}x!)\x1b[0m`; // Red with ! for reckless
  } else if (inc >= 4) {
    return `\x1b[33m(${inc}x)\x1b[0m`; // Yellow for caution
  } else if (inc > 0) {
    return `(${inc}x)`; // Normal
  }
  return '(0x)'; // Clean so far
}

// ============================================================================
// Driver Analysis (from liveSessionAnalysis.ts)
// ============================================================================

function extractLicenseClass(licenseString: string): string {
  if (!licenseString) return '?';
  const match = licenseString.match(/^([RDCBA]|Pro)/i);
  return match ? match[1].toUpperCase() : '?';
}

async function analyzeSingleDriver(
  driver: SessionDriver,
  isMe: boolean
): Promise<AnalyzedDriver> {
  const licenseClass = extractLicenseClass(driver.licenseLevel);
  const emptyIncidentTypes: IncidentTypes = { contact4x: 0, lostControl2x: 0, offTrack1x: 0, total: 0 };

  if (!authenticated || !client) {
    return {
      carIdx: driver.carIdx,
      carNumber: driver.carNumber,
      custId: driver.custId,
      name: driver.name,
      sr: driver.licenseLevel,
      licenseClass,
      iRating: driver.iRating,
      totalRaces: 0,
      recentRaces: 0,
      avgIncidents: 0,
      recentAvgIncidents: 0,
      lastRaceIncidents: 0,
      incidentTypes: emptyIncidentTypes,
      riskScore: -1,
      riskLevel: 'UNKNOWN',
      patterns: [],
      isMe,
    };
  }

  try {
    const profile = await analyzeDriver(client, driver.custId, 10);
    return {
      carIdx: driver.carIdx,
      carNumber: driver.carNumber,
      custId: driver.custId,
      name: driver.name,
      sr: profile.sr.toFixed(2),
      licenseClass,
      iRating: driver.iRating || profile.irating,
      totalRaces: profile.totalRacesAnalyzed,
      recentRaces: profile.recentRaces,
      avgIncidents: profile.avgIncidentsPerRace,
      recentAvgIncidents: profile.recentAvgIncidents,
      lastRaceIncidents: profile.lastRaceIncidents,
      incidentTypes: profile.incidentTypes,
      riskScore: profile.riskScore,
      riskLevel: isMe ? 'YOU' : profile.riskLevel,
      patterns: profile.keyPatterns,
      isMe,
    };
  } catch (e) {
    return {
      carIdx: driver.carIdx,
      carNumber: driver.carNumber,
      custId: driver.custId,
      name: driver.name,
      sr: driver.licenseLevel,
      licenseClass,
      iRating: driver.iRating,
      totalRaces: 0,
      recentRaces: 0,
      avgIncidents: 0,
      recentAvgIncidents: 0,
      lastRaceIncidents: 0,
      incidentTypes: emptyIncidentTypes,
      riskScore: -1,
      riskLevel: isMe ? 'YOU' : 'UNKNOWN',
      patterns: [],
      isMe,
    };
  }
}

async function processDriversInParallel(drivers: SessionDriver[], batchSize: number = 4): Promise<AnalyzedDriver[]> {
  const results: AnalyzedDriver[] = [];

  for (let i = 0; i < drivers.length; i += batchSize) {
    const batch = drivers.slice(i, i + batchSize);
    const batchNum = Math.floor(i / batchSize) + 1;
    const totalBatches = Math.ceil(drivers.length / batchSize);

    process.stdout.write(`  Batch ${batchNum}/${totalBatches} (#${batch.map(d => d.carNumber).join(', #')})...`);

    const batchPromises = batch.map(driver =>
      analyzeSingleDriver(driver, driver.custId === myCustId)
    );

    const batchResults = await Promise.all(batchPromises);
    results.push(...batchResults);

    const riskCounts = batchResults.reduce((acc, r) => {
      if (r.isMe) acc.you++;
      else if (r.riskLevel === 'HIGH') acc.high++;
      else if (r.riskLevel === 'MODERATE') acc.mod++;
      else if (r.riskLevel === 'LOW') acc.low++;
      else acc.unknown++;
      return acc;
    }, { high: 0, mod: 0, low: 0, you: 0, unknown: 0 });

    const summary: string[] = [];
    if (riskCounts.high > 0) summary.push(`${riskCounts.high} HIGH`);
    if (riskCounts.mod > 0) summary.push(`${riskCounts.mod} MOD`);
    if (riskCounts.low > 0) summary.push(`${riskCounts.low} LOW`);
    if (riskCounts.you > 0) summary.push('YOU');
    if (riskCounts.unknown > 0) summary.push(`${riskCounts.unknown} ?`);

    console.log(` [${summary.join(', ')}]`);

    if (i + batchSize < drivers.length) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  return results;
}

// ============================================================================
// Output Functions
// ============================================================================

function printDriverTable(analyses: AnalyzedDriver[]) {
  console.log('\n' + '='.repeat(110));
  console.log('                                    GRID ANALYSIS');
  console.log('='.repeat(110));

  console.log('');
  console.log(
    padRight('Car#', 6) +
    padRight('SR', 6) +
    padRight('iRating', 8) +
    padRight('Races', 6) +
    padRight('Inc/Race', 9) +
    padRight('4x', 5) +
    padRight('2x', 5) +
    padRight('1x', 5) +
    padRight('Risk', 15) +
    'Notes'
  );
  console.log('-'.repeat(110));

  const sorted = [...analyses].sort((a, b) => {
    if (a.isMe) return -1;
    if (b.isMe) return 1;
    return b.riskScore - a.riskScore;
  });

  for (const d of sorted) {
    const riskDisplay = d.isMe ? 'YOU' : `${d.riskLevel} (${d.riskScore})`;
    const notes = d.patterns.length > 0 ? truncate(d.patterns[0], 40) : '';

    const row =
      padRight(`#${d.carNumber}`, 6) +
      padRight(d.sr, 6) +
      padRight(d.iRating.toString(), 8) +
      padRight(d.totalRaces.toString(), 6) +
      padRight(d.avgIncidents.toFixed(1), 9) +
      padRight(d.incidentTypes.contact4x.toString(), 5) +
      padRight(d.incidentTypes.lostControl2x.toString(), 5) +
      padRight(d.incidentTypes.offTrack1x.toString(), 5) +
      padRight(riskDisplay, 15) +
      notes;

    if (d.isMe) {
      console.log(`\x1b[36m${row}\x1b[0m`);
    } else if (d.riskLevel === 'HIGH') {
      console.log(`\x1b[31m${row}\x1b[0m`);
    } else if (d.riskLevel === 'MODERATE') {
      console.log(`\x1b[33m${row}\x1b[0m`);
    } else if (d.riskLevel === 'LOW') {
      console.log(`\x1b[32m${row}\x1b[0m`);
    } else {
      console.log(row);
    }
  }

  console.log('-'.repeat(110));
}

function calculateFieldStats(analyses: AnalyzedDriver[]): FieldStats {
  const iRatings = analyses.filter(a => a.iRating > 0).map(a => a.iRating);
  const sof = iRatings.length > 0
    ? Math.round(iRatings.reduce((sum, ir) => sum + ir, 0) / iRatings.length)
    : 0;

  const licenseBreakdown: { [key: string]: number } = {};
  for (const d of analyses) {
    const cls = d.licenseClass || '?';
    licenseBreakdown[cls] = (licenseBreakdown[cls] || 0) + 1;
  }

  const srValues = analyses
    .map(a => parseFloat(a.sr))
    .filter(sr => !isNaN(sr) && sr > 0);
  const avgSR = srValues.length > 0
    ? srValues.reduce((sum, sr) => sum + sr, 0) / srValues.length
    : 0;

  const rookieCount = licenseBreakdown['R'] || 0;

  return { sof, licenseBreakdown, avgSR, rookieCount };
}

function printSummary(analyses: AnalyzedDriver[]) {
  const highRisk = analyses.filter(a => a.riskLevel === 'HIGH');
  const moderate = analyses.filter(a => a.riskLevel === 'MODERATE');
  const lowRisk = analyses.filter(a => a.riskLevel === 'LOW');

  const analyzedDrivers = analyses.filter(a => a.riskScore >= 0 && !a.isMe);
  const avgRisk = analyzedDrivers.length > 0
    ? analyzedDrivers.reduce((sum, a) => sum + a.riskScore, 0) / analyzedDrivers.length
    : 0;

  const fieldStats = calculateFieldStats(analyses);

  console.log('\n' + '='.repeat(80));
  console.log('                           FIELD & RISK SUMMARY');
  console.log('='.repeat(80));

  console.log('\n  FIELD COMPOSITION:');
  console.log(`    SOF: ${fieldStats.sof} | Avg SR: ${fieldStats.avgSR.toFixed(2)}`);

  const licenseOrder = ['Pro', 'A', 'B', 'C', 'D', 'R'];
  const licenseDisplay = licenseOrder
    .filter(cls => fieldStats.licenseBreakdown[cls] > 0)
    .map(cls => `${cls}: ${fieldStats.licenseBreakdown[cls]}`)
    .join(' | ');
  console.log(`    Licenses: ${licenseDisplay || 'Unknown'}`);

  console.log('\n  RISK BREAKDOWN:');
  console.log(`    Overall Grid Risk: ${avgRisk.toFixed(1)}/10`);
  console.log(`    \x1b[31mHigh Risk: ${highRisk.length}\x1b[0m | \x1b[33mModerate: ${moderate.length}\x1b[0m | \x1b[32mLow Risk: ${lowRisk.length}\x1b[0m`);

  if (highRisk.length > 0) {
    console.log('\n  \x1b[31mCARS TO AVOID:\x1b[0m');
    for (const d of highRisk.slice(0, 5)) {
      const pattern = d.patterns.length > 0 ? ` - ${d.patterns[0]}` : '';
      console.log(`    #${d.carNumber} (${d.avgIncidents} avg inc)${pattern}`);
    }
  }

  if (lowRisk.length > 0) {
    console.log('\n  \x1b[32mSAFE TO RACE WITH:\x1b[0m');
    for (const d of lowRisk.slice(0, 3)) {
      console.log(`    #${d.carNumber} (${d.avgIncidents} avg inc)`);
    }
  }

  console.log('\n  STRATEGY:');

  const rookiePercent = (fieldStats.rookieCount / analyses.length) * 100;
  const hasLotOfRookies = rookiePercent >= 30;
  const inexperiencedDrivers = analyses.filter(a => a.totalRaces > 0 && a.totalRaces < 5 && !a.isMe);
  const inexperiencedPercent = (inexperiencedDrivers.length / analyses.length) * 100;
  const hasLotOfInexperienced = inexperiencedPercent >= 40;
  const isHighSOF = fieldStats.sof >= 2200;

  if (avgRisk >= 6) {
    console.log('  \x1b[31m  CONSERVATIVE - Let the field settle, prioritize clean finish\x1b[0m');
  } else if (avgRisk >= 4) {
    console.log('  \x1b[33m  MODERATE - Race normally but stay alert around flagged drivers\x1b[0m');
  } else {
    console.log('  \x1b[32m  AGGRESSIVE OK - Field is clean, good opportunity for gains\x1b[0m');
  }

  if (hasLotOfRookies) {
    console.log(`  \x1b[31m  WARNING: ${fieldStats.rookieCount} Rookies (${rookiePercent.toFixed(0)}%) - expect unpredictable behavior\x1b[0m`);
  }

  if (hasLotOfInexperienced) {
    console.log(`  \x1b[33m  WARNING: ${inexperiencedDrivers.length} drivers with <5 races (${inexperiencedPercent.toFixed(0)}%) - inconsistent pace/braking likely\x1b[0m`);
  }

  if (isHighSOF) {
    console.log(`  \x1b[32m  NOTE: High SOF (${fieldStats.sof}) - expect competitive but cleaner racing\x1b[0m`);
  }

  console.log('\n' + '='.repeat(80));
}

function padRight(str: string, len: number): string {
  return str.length >= len ? str.substring(0, len) : str + ' '.repeat(len - str.length);
}

function truncate(str: string, len: number): string {
  return str.length > len ? str.substring(0, len - 2) + '..' : str;
}

// ============================================================================
// Start
// ============================================================================

racesafe().catch(console.error);
