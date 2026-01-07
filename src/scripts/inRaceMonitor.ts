import * as dotenv from 'dotenv';
import * as irsdk from 'iracing-sdk-js';
import { IRacingClient } from '../api/iracingClient';
import { analyzeDriver } from '../analysis/riskAnalysis';
import { DriverRiskProfile } from '../types';

dotenv.config();

const myCustId = parseInt(process.env.IRACING_CUST_ID || '0');

interface DriverPosition {
  carIdx: number;
  custId: number;
  name: string;
  carNumber: string;
  position: number;
  classPosition: number;
  lap: number;
  lapDistPct: number;  // 0-1, position on track
  gapToLeader: number;
  gapToAhead: number;
  gapToBehind: number;
  isOnPitRoad: boolean;
  riskProfile: DriverRiskProfile | null;
}

interface NearbyDriver {
  driver: DriverPosition;
  gap: number;
  direction: 'AHEAD' | 'BEHIND';
  threatLevel: 'HIGH' | 'MODERATE' | 'LOW' | 'UNKNOWN';
}

// Store risk profiles so we don't re-fetch during the race
const riskProfileCache: Map<number, DriverRiskProfile> = new Map();
let sessionDrivers: Map<number, { custId: number; name: string; carNumber: string }> = new Map();
let myCarIdx = -1;
let lastAlertTime = 0;
const ALERT_COOLDOWN = 5000; // 5 seconds between alerts

/**
 * In-Race Monitor - provides real-time proximity alerts
 */
async function inRaceMonitor() {
  console.log('='.repeat(80));
  console.log('              RACESAFE - IN-RACE MONITOR');
  console.log('='.repeat(80));
  console.log('\nConnecting to iRacing...');

  const iracing = irsdk.init({
    telemetryUpdateInterval: 500,  // 2Hz telemetry updates
    sessionInfoUpdateInterval: 5000,
  });

  let authenticated = false;
  let client: IRacingClient | null = null;

  iracing.on('Connected', async () => {
    console.log('Connected to iRacing simulator!');
    console.log('Loading driver risk profiles...\n');

    // Authenticate with iRacing API
    client = new IRacingClient();
    const email = process.env.IRACING_EMAIL!;
    const password = process.env.IRACING_PASSWORD!;
    const clientId = process.env.IRACING_CLIENT_ID!;
    const clientSecret = process.env.IRACING_CLIENT_SECRET!;

    try {
      await client.authenticate(email, password, clientId, clientSecret);
      authenticated = true;
    } catch (error) {
      console.log('Warning: Could not authenticate - running without risk profiles');
    }
  });

  iracing.on('Disconnected', () => {
    console.log('\nDisconnected from iRacing.');
    process.exit(0);
  });

  // Handle session info - get driver list
  iracing.on('SessionInfo', async (evt: any) => {
    const sessionInfo = evt.data;
    const driverInfo = sessionInfo.DriverInfo;

    if (!driverInfo?.Drivers) return;

    // Build driver map
    for (const d of driverInfo.Drivers) {
      if (!d.UserName || d.UserName === 'Pace Car') continue;

      sessionDrivers.set(d.CarIdx, {
        custId: d.UserID,
        name: d.UserName,
        carNumber: d.CarNumber || d.CarIdx.toString(),
      });

      if (d.UserID === myCustId) {
        myCarIdx = d.CarIdx;
      }

      // Fetch risk profile if we don't have it
      if (authenticated && client && !riskProfileCache.has(d.UserID)) {
        try {
          const profile = await analyzeDriver(client, d.UserID, 10);
          riskProfileCache.set(d.UserID, profile);
        } catch (e) {
          // Driver might not have race history
        }
      }
    }

    if (myCarIdx === -1) {
      console.log('Warning: Could not find your car. Check IRACING_CUST_ID in .env');
    }
  });

  // Handle telemetry updates - this is where we monitor positions
  iracing.on('Telemetry', (evt: any) => {
    if (myCarIdx === -1) return;

    const telemetry = evt.values;

    // Get position data for all cars
    const carIdxLap = telemetry.CarIdxLap || [];
    const carIdxLapDistPct = telemetry.CarIdxLapDistPct || [];
    const carIdxPosition = telemetry.CarIdxPosition || [];
    const carIdxClassPosition = telemetry.CarIdxClassPosition || [];
    const carIdxOnPitRoad = telemetry.CarIdxOnPitRoad || [];
    const carIdxEstTime = telemetry.CarIdxEstTime || [];

    // Build current positions
    const positions: DriverPosition[] = [];

    for (const [carIdx, driverInfo] of sessionDrivers) {
      if (carIdxLap[carIdx] < 0) continue; // Not on track

      const profile = riskProfileCache.get(driverInfo.custId) || null;

      positions.push({
        carIdx,
        custId: driverInfo.custId,
        name: driverInfo.name,
        carNumber: driverInfo.carNumber,
        position: carIdxPosition[carIdx] || 0,
        classPosition: carIdxClassPosition[carIdx] || 0,
        lap: carIdxLap[carIdx] || 0,
        lapDistPct: carIdxLapDistPct[carIdx] || 0,
        gapToLeader: 0,
        gapToAhead: 0,
        gapToBehind: 0,
        isOnPitRoad: carIdxOnPitRoad[carIdx] || false,
        riskProfile: profile,
      });
    }

    // Find my position
    const myPosition = positions.find(p => p.carIdx === myCarIdx);
    if (!myPosition) return;

    // Calculate gaps and find nearby drivers
    const nearbyDrivers = findNearbyDrivers(myPosition, positions, telemetry);

    // Display status
    displayStatus(myPosition, nearbyDrivers, positions.length);
  });

  // Keep running
  console.log('Monitoring... Press Ctrl+C to exit.\n');
}

/**
 * Find drivers that are close to us on track
 */
function findNearbyDrivers(
  myPos: DriverPosition,
  allPositions: DriverPosition[],
  telemetry: any
): NearbyDriver[] {
  const nearby: NearbyDriver[] = [];
  const myLapDistPct = myPos.lapDistPct;

  // Get session time for gap calculation
  const sessionTime = telemetry.SessionTime || 0;
  const carIdxEstTime = telemetry.CarIdxEstTime || [];

  for (const driver of allPositions) {
    if (driver.carIdx === myPos.carIdx) continue;
    if (driver.isOnPitRoad) continue;

    // Calculate track gap (accounting for track wraparound)
    let trackGap = driver.lapDistPct - myLapDistPct;
    if (trackGap > 0.5) trackGap -= 1;
    if (trackGap < -0.5) trackGap += 1;

    // Convert to approximate seconds (rough estimate based on lap time)
    // Positive = ahead, negative = behind
    const avgLapTime = 90; // Rough estimate, could get from telemetry
    const gapSeconds = Math.abs(trackGap * avgLapTime);

    // Only care about drivers within ~5 seconds
    if (gapSeconds > 5) continue;

    const direction = trackGap > 0 ? 'AHEAD' : 'BEHIND';

    // Determine threat level based on risk profile
    let threatLevel: 'HIGH' | 'MODERATE' | 'LOW' | 'UNKNOWN' = 'UNKNOWN';
    if (driver.riskProfile) {
      threatLevel = driver.riskProfile.riskLevel;
    }

    nearby.push({
      driver,
      gap: gapSeconds,
      direction,
      threatLevel,
    });
  }

  // Sort by gap
  nearby.sort((a, b) => a.gap - b.gap);

  return nearby;
}

/**
 * Display current status and alerts
 */
function displayStatus(
  myPos: DriverPosition,
  nearby: NearbyDriver[],
  totalCars: number
) {
  const now = Date.now();

  // Clear line and write status
  process.stdout.write('\r\x1b[K');

  // Position info
  const posStr = `P${myPos.classPosition}/${totalCars}`;

  // Find closest ahead and behind
  const closestAhead = nearby.find(n => n.direction === 'AHEAD');
  const closestBehind = nearby.find(n => n.direction === 'BEHIND');

  let statusLine = `${posStr} | `;

  // Ahead info
  if (closestAhead) {
    const color = getThreatColor(closestAhead.threatLevel);
    const arrow = closestAhead.gap < 1.5 ? '\x1b[5m↑\x1b[25m' : '↑'; // Blink if very close
    statusLine += `${color}${arrow} #${closestAhead.driver.carNumber} ${closestAhead.gap.toFixed(1)}s (${closestAhead.threatLevel})\x1b[0m | `;
  } else {
    statusLine += '↑ Clear | ';
  }

  // Behind info
  if (closestBehind) {
    const color = getThreatColor(closestBehind.threatLevel);
    const arrow = closestBehind.gap < 1.5 ? '\x1b[5m↓\x1b[25m' : '↓';
    statusLine += `${color}${arrow} #${closestBehind.driver.carNumber} ${closestBehind.gap.toFixed(1)}s (${closestBehind.threatLevel})\x1b[0m`;
  } else {
    statusLine += '↓ Clear';
  }

  process.stdout.write(statusLine);

  // Alert for HIGH risk drivers within 2 seconds
  if (now - lastAlertTime > ALERT_COOLDOWN) {
    const highRiskNearby = nearby.filter(n => n.threatLevel === 'HIGH' && n.gap < 2);

    if (highRiskNearby.length > 0) {
      lastAlertTime = now;
      console.log(''); // New line
      for (const threat of highRiskNearby) {
        const dirStr = threat.direction === 'AHEAD' ? 'AHEAD' : 'BEHIND';
        console.log(`\x1b[41m\x1b[37m ⚠ DANGER: #${threat.driver.carNumber} ${threat.driver.name} ${dirStr} - HIGH RISK DRIVER \x1b[0m`);

        if (threat.driver.riskProfile) {
          const pattern = threat.driver.riskProfile.keyPatterns[0] || '';
          if (pattern) {
            console.log(`   ${pattern}`);
          }
        }
      }
    }
  }
}

/**
 * Get ANSI color code for threat level
 */
function getThreatColor(level: string): string {
  switch (level) {
    case 'HIGH': return '\x1b[31m'; // Red
    case 'MODERATE': return '\x1b[33m'; // Yellow
    case 'LOW': return '\x1b[32m'; // Green
    default: return '\x1b[37m'; // White
  }
}

inRaceMonitor().catch(console.error);
