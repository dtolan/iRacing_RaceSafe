import * as dotenv from 'dotenv';
import * as irsdk from 'iracing-sdk-js';
import { IRacingClient } from '../api/iracingClient';
import { analyzeDriver } from '../analysis/riskAnalysis';

dotenv.config();

const myCustId = parseInt(process.env.IRACING_CUST_ID || '1247460');

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
  carNumber: string;
  custId: number;
  name: string;
  sr: string;
  licenseClass: string;  // R, D, C, B, A, Pro
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

/**
 * Live Session Analysis - connects to running iRacing instance
 * and analyzes drivers in the current session
 */
async function liveSessionAnalysis() {
  console.log('='.repeat(115));
  console.log('                              RACESAFE - LIVE SESSION ANALYZER');
  console.log('='.repeat(115));
  console.log('\nConnecting to iRacing...');

  const iracing = irsdk.init({
    telemetryUpdateInterval: 1000,
    sessionInfoUpdateInterval: 1000,
  });

  let sessionInfoReceived = false;

  // Handle connection
  iracing.on('Connected', () => {
    console.log('Connected to iRacing simulator!');
  });

  iracing.on('Disconnected', () => {
    console.log('\nDisconnected from iRacing.');
    if (!sessionInfoReceived) {
      console.log('\nMake sure iRacing is running and you are in a session.');
      process.exit(1);
    }
  });

  // Handle session info updates
  iracing.on('SessionInfo', async (evt: any) => {
    if (sessionInfoReceived) return;
    sessionInfoReceived = true;

    const sessionInfo = evt.data;
    console.log('\nSession info received!');

    // Extract session details
    const weekendInfo = sessionInfo.WeekendInfo;
    if (weekendInfo) {
      console.log(`\nTrack: ${weekendInfo.TrackDisplayName || weekendInfo.TrackName}`);
      console.log(`Series: ${weekendInfo.SeriesID ? `Series ${weekendInfo.SeriesID}` : 'Unknown'}`);
    }

    // Extract driver info
    const driverInfo = sessionInfo.DriverInfo;
    if (!driverInfo?.Drivers) {
      console.log('\nNo driver information available yet.');
      sessionInfoReceived = false;
      return;
    }

    const drivers: SessionDriver[] = driverInfo.Drivers
      .filter((d: any) => d.UserName && d.UserName !== 'Pace Car')
      .map((d: any) => ({
        carIdx: d.CarIdx,
        custId: d.UserID,
        name: d.UserName,
        iRating: d.IRating || 0,
        licenseLevel: d.LicString || 'Unknown',
        carNumber: d.CarNumber || d.CarIdx.toString(),
      }));

    if (drivers.length === 0) {
      console.log('\nNo drivers found. Session may still be loading...');
      sessionInfoReceived = false;
      return;
    }

    console.log(`Drivers in session: ${drivers.length}`);
    await analyzeSessionDrivers(drivers);
    process.exit(0);
  });

  // Timeout if no connection
  setTimeout(() => {
    if (!sessionInfoReceived) {
      console.log('\nTimeout: Could not connect to iRacing.');
      console.log('\nTroubleshooting:');
      console.log('  1. Make sure iRacing is running');
      console.log('  2. Join a session (practice, qualify, or race)');
      console.log('  3. The simulator must be open (not just the UI)');
      process.exit(1);
    }
  }, 10000);
}

/**
 * Analyze a single driver and return the result
 */
/**
 * Extract license class letter from license string (e.g., "B 2.72" -> "B")
 */
function extractLicenseClass(licenseString: string): string {
  if (!licenseString) return '?';
  const match = licenseString.match(/^([RDCBA]|Pro)/i);
  return match ? match[1].toUpperCase() : '?';
}

async function analyzeSingleDriver(
  client: IRacingClient,
  driver: SessionDriver,
  isMe: boolean
): Promise<AnalyzedDriver> {
  const licenseClass = extractLicenseClass(driver.licenseLevel);

  const emptyIncidentTypes: IncidentTypes = { contact4x: 0, lostControl2x: 0, offTrack1x: 0, total: 0 };

  if (isMe) {
    try {
      const profile = await analyzeDriver(client, driver.custId, 10);
      return {
        carNumber: driver.carNumber,
        custId: driver.custId,
        name: driver.name,
        sr: profile.sr.toFixed(2),
        licenseClass,
        // Prefer session iRating (always accurate) over API iRating
        iRating: driver.iRating || profile.irating,
        totalRaces: profile.totalRacesAnalyzed,
        recentRaces: profile.recentRaces,
        avgIncidents: profile.avgIncidentsPerRace,
        recentAvgIncidents: profile.recentAvgIncidents,
        lastRaceIncidents: profile.lastRaceIncidents,
        incidentTypes: profile.incidentTypes,
        riskScore: profile.riskScore,
        riskLevel: 'YOU',
        patterns: profile.keyPatterns,
        isMe: true,
      };
    } catch {
      return {
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
        riskScore: 0,
        riskLevel: 'YOU',
        patterns: [],
        isMe: true,
      };
    }
  }

  try {
    const profile = await analyzeDriver(client, driver.custId, 10);
    return {
      carNumber: driver.carNumber,
      custId: driver.custId,
      name: driver.name,
      sr: profile.sr.toFixed(2),
      licenseClass,
      // Prefer session iRating (always accurate) over API iRating (may be 0 for new drivers)
      iRating: driver.iRating || profile.irating,
      totalRaces: profile.totalRacesAnalyzed,
      recentRaces: profile.recentRaces,
      avgIncidents: profile.avgIncidentsPerRace,
      recentAvgIncidents: profile.recentAvgIncidents,
      lastRaceIncidents: profile.lastRaceIncidents,
      incidentTypes: profile.incidentTypes,
      riskScore: profile.riskScore,
      riskLevel: profile.riskLevel,
      patterns: profile.keyPatterns,
      isMe: false,
    };
  } catch (e) {
    return {
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
      isMe: false,
    };
  }
}

/**
 * Process drivers in parallel batches
 * Using batches of 4 to stay well under rate limits
 */
async function processDriversInParallel(
  client: IRacingClient,
  drivers: SessionDriver[],
  batchSize: number = 4
): Promise<AnalyzedDriver[]> {
  const results: AnalyzedDriver[] = [];
  const totalDrivers = drivers.length;

  for (let i = 0; i < drivers.length; i += batchSize) {
    const batch = drivers.slice(i, i + batchSize);
    const batchNum = Math.floor(i / batchSize) + 1;
    const totalBatches = Math.ceil(drivers.length / batchSize);

    process.stdout.write(`  Analyzing batch ${batchNum}/${totalBatches} (${batch.map(d => d.carNumber).join(', ')})...`);

    const batchPromises = batch.map(driver =>
      analyzeSingleDriver(client, driver, driver.custId === myCustId)
    );

    const batchResults = await Promise.all(batchPromises);
    results.push(...batchResults);

    // Print batch results summary
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

    // Small delay between batches to be respectful of rate limits
    if (i + batchSize < drivers.length) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  return results;
}

async function analyzeSessionDrivers(drivers: SessionDriver[]) {
  // Sort by car number
  drivers.sort((a, b) => {
    const numA = parseInt(a.carNumber) || 999;
    const numB = parseInt(b.carNumber) || 999;
    return numA - numB;
  });

  console.log('\nFetching detailed risk profiles (parallel processing)...\n');

  const client = new IRacingClient();
  const email = process.env.IRACING_EMAIL!;
  const password = process.env.IRACING_PASSWORD!;
  const clientId = process.env.IRACING_CLIENT_ID!;
  const clientSecret = process.env.IRACING_CLIENT_SECRET!;

  try {
    await client.authenticate(email, password, clientId, clientSecret);
  } catch (error) {
    console.log('Could not authenticate with iRacing API.');
    return;
  }

  // Process all drivers in parallel batches
  const analyses = await processDriversInParallel(client, drivers);

  // Print table
  printDriverTable(analyses);

  // Print summary and recommendations
  printSummary(analyses);
}

function printDriverTable(analyses: AnalyzedDriver[]) {
  console.log('\n' + '='.repeat(140));
  console.log('                                              DRIVER GRID ANALYSIS');
  console.log('='.repeat(140));

  // Table header
  console.log('');
  console.log(
    padRight('Car#', 5) +
    padRight('Driver Name', 22) +
    padRight('SR', 6) +
    padRight('iRating', 8) +
    padRight('Races', 6) +
    padRight('Inc/Race', 9) +
    padRight('4x', 4) +
    padRight('2x', 4) +
    padRight('1x', 4) +
    padRight('Risk', 15) +
    'Notes'
  );
  console.log('-'.repeat(140));

  // Sort by risk score (highest first), but put YOU at top
  const sorted = [...analyses].sort((a, b) => {
    if (a.isMe) return -1;
    if (b.isMe) return 1;
    return b.riskScore - a.riskScore;
  });

  for (const d of sorted) {
    const riskDisplay = d.isMe ? 'YOU' : `${d.riskLevel} (${d.riskScore})`;
    const notes = d.patterns.length > 0 ? truncate(d.patterns[0], 30) : '';

    const row =
      padRight(`#${d.carNumber}`, 5) +
      padRight(truncate(d.name, 20), 22) +
      padRight(d.sr, 6) +
      padRight(d.iRating.toString(), 8) +
      padRight(d.totalRaces.toString(), 6) +
      padRight(d.avgIncidents.toFixed(1), 9) +
      padRight(d.incidentTypes.contact4x.toString(), 4) +
      padRight(d.incidentTypes.lostControl2x.toString(), 4) +
      padRight(d.incidentTypes.offTrack1x.toString(), 4) +
      padRight(riskDisplay, 15) +
      notes;

    // Color code by risk level
    if (d.isMe) {
      console.log(`\x1b[36m${row}\x1b[0m`); // Cyan for YOU
    } else if (d.riskLevel === 'HIGH') {
      console.log(`\x1b[31m${row}\x1b[0m`); // Red for HIGH
    } else if (d.riskLevel === 'MODERATE') {
      console.log(`\x1b[33m${row}\x1b[0m`); // Yellow for MODERATE
    } else if (d.riskLevel === 'LOW') {
      console.log(`\x1b[32m${row}\x1b[0m`); // Green for LOW
    } else {
      console.log(row);
    }
  }

  console.log('-'.repeat(140));
}

/**
 * Calculate field statistics (SOF, license breakdown)
 */
function calculateFieldStats(analyses: AnalyzedDriver[]): FieldStats {
  // Calculate SOF (average iRating)
  const iRatings = analyses.filter(a => a.iRating > 0).map(a => a.iRating);
  const sof = iRatings.length > 0
    ? Math.round(iRatings.reduce((sum, ir) => sum + ir, 0) / iRatings.length)
    : 0;

  // Count license classes
  const licenseBreakdown: { [key: string]: number } = {};
  for (const d of analyses) {
    const cls = d.licenseClass || '?';
    licenseBreakdown[cls] = (licenseBreakdown[cls] || 0) + 1;
  }

  // Calculate average SR
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
  const highRisk = analyses.filter((a) => a.riskLevel === 'HIGH');
  const moderate = analyses.filter((a) => a.riskLevel === 'MODERATE');
  const lowRisk = analyses.filter((a) => a.riskLevel === 'LOW');

  const analyzedDrivers = analyses.filter((a) => a.riskScore >= 0 && !a.isMe);
  const avgRisk = analyzedDrivers.length > 0
    ? analyzedDrivers.reduce((sum, a) => sum + a.riskScore, 0) / analyzedDrivers.length
    : 0;

  // Calculate field stats
  const fieldStats = calculateFieldStats(analyses);

  console.log('\n' + '='.repeat(80));
  console.log('                           FIELD & RISK SUMMARY');
  console.log('='.repeat(80));

  // Field stats
  console.log('\n  FIELD COMPOSITION:');
  console.log(`    SOF: ${fieldStats.sof} | Avg SR: ${fieldStats.avgSR.toFixed(2)}`);

  // License breakdown - display in order
  const licenseOrder = ['Pro', 'A', 'B', 'C', 'D', 'R'];
  const licenseDisplay = licenseOrder
    .filter(cls => fieldStats.licenseBreakdown[cls] > 0)
    .map(cls => `${cls}: ${fieldStats.licenseBreakdown[cls]}`)
    .join(' | ');
  console.log(`    Licenses: ${licenseDisplay || 'Unknown'}`);

  // Risk summary
  console.log('\n  RISK BREAKDOWN:');
  console.log(`    Overall Grid Risk: ${avgRisk.toFixed(1)}/10`);
  console.log(`    \x1b[31mHigh Risk: ${highRisk.length}\x1b[0m | \x1b[33mModerate: ${moderate.length}\x1b[0m | \x1b[32mLow Risk: ${lowRisk.length}\x1b[0m`);

  if (highRisk.length > 0) {
    console.log('\n  \x1b[31mDRIVERS TO AVOID:\x1b[0m');
    for (const d of highRisk.slice(0, 5)) {
      const pattern = d.patterns.length > 0 ? ` - ${d.patterns[0]}` : '';
      console.log(`    #${d.carNumber} ${d.name}${pattern}`);
    }
  }

  if (lowRisk.length > 0) {
    console.log('\n  \x1b[32mSAFE TO RACE WITH:\x1b[0m');
    for (const d of lowRisk.slice(0, 3)) {
      console.log(`    #${d.carNumber} ${d.name} (${d.avgIncidents} avg inc)`);
    }
  }

  // Strategic recommendation - factor in field composition
  console.log('\n  STRATEGY:');

  const rookiePercent = (fieldStats.rookieCount / analyses.length) * 100;
  const hasLotOfRookies = rookiePercent >= 30;

  // Count inexperienced drivers (fewer than 5 races in 30 days = still learning)
  const inexperiencedDrivers = analyses.filter(a => a.totalRaces > 0 && a.totalRaces < 5 && !a.isMe);
  const inexperiencedPercent = (inexperiencedDrivers.length / analyses.length) * 100;
  const hasLotOfInexperienced = inexperiencedPercent >= 40;

  // SOF context - only notable at extremes
  const isHighSOF = fieldStats.sof >= 2200;

  // Build strategy factors
  const factors: string[] = [];

  if (avgRisk >= 6) {
    console.log('  \x1b[31m  CONSERVATIVE - Let the field settle, prioritize clean finish\x1b[0m');
    factors.push('High-risk field');
  } else if (avgRisk >= 4) {
    console.log('  \x1b[33m  MODERATE - Race normally but stay alert around flagged drivers\x1b[0m');
    factors.push('Mixed field');
  } else {
    console.log('  \x1b[32m  AGGRESSIVE OK - Field is clean, good opportunity for gains\x1b[0m');
    factors.push('Clean field');
  }

  // Warnings based on field experience level
  if (hasLotOfRookies) {
    console.log(`  \x1b[31m  WARNING: ${fieldStats.rookieCount} Rookies (${rookiePercent.toFixed(0)}%) - expect unpredictable behavior\x1b[0m`);
    factors.push('High rookie count');
  }

  if (hasLotOfInexperienced) {
    console.log(`  \x1b[33m  WARNING: ${inexperiencedDrivers.length} drivers with <5 races (${inexperiencedPercent.toFixed(0)}%) - inconsistent pace/braking likely\x1b[0m`);
    factors.push('Many inexperienced drivers');
  }

  if (isHighSOF) {
    console.log(`  \x1b[32m  NOTE: High SOF (${fieldStats.sof}) - expect competitive but cleaner racing\x1b[0m`);
    factors.push('High SOF');
  }

  console.log('\n' + '='.repeat(80));
}

function padRight(str: string, len: number): string {
  return str.length >= len ? str.substring(0, len) : str + ' '.repeat(len - str.length);
}

function truncate(str: string, len: number): string {
  return str.length > len ? str.substring(0, len - 2) + '..' : str;
}

liveSessionAnalysis().catch(console.error);
