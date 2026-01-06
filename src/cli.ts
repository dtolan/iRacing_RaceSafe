import { Command } from 'commander';
import * as dotenv from 'dotenv';
import { IRacingClient } from './api/iracingClient';
import { analyzeDriver } from './analysis/riskAnalysis';
import { analyzeRaceGrid, formatGridAnalysis } from './analysis/gridAnalysis';
import { UserProfile } from './types';

// Load environment variables
dotenv.config();

const program = new Command();

program
  .name('racesafe')
  .description('AI-powered driver behavior analysis for iRacing')
  .version('0.1.0');

/**
 * Helper to get and validate OAuth credentials from environment
 */
function getCredentials() {
  const clientId = process.env.IRACING_CLIENT_ID;
  const clientSecret = process.env.IRACING_CLIENT_SECRET;
  const email = process.env.IRACING_EMAIL;
  const password = process.env.IRACING_PASSWORD;

  if (!clientId || !clientSecret) {
    console.error('Error: IRACING_CLIENT_ID and IRACING_CLIENT_SECRET must be set in .env file');
    process.exit(1);
  }

  if (!email || !password) {
    console.error('Error: IRACING_EMAIL and IRACING_PASSWORD must be set in .env file');
    process.exit(1);
  }

  return { clientId, clientSecret, email, password };
}

/**
 * Helper to authenticate the client
 */
async function authenticateClient(client: IRacingClient): Promise<void> {
  const { clientId, clientSecret, email, password } = getCredentials();

  console.log('Authenticating with iRacing OAuth...');
  const authenticated = await client.authenticate(email, password, clientId, clientSecret);

  if (!authenticated) {
    console.error('Failed to authenticate with iRacing API');
    process.exit(1);
  }
}

/**
 * Analyze a race session grid
 */
program
  .command('analyze')
  .description('Analyze a race session grid for driver risk profiles')
  .requiredOption('--session-id <id>', 'iRacing session/subsession ID')
  .requiredOption('--my-sr <sr>', 'Your current Safety Rating (e.g., 1.9)')
  .option('--sr-goal <goal>', 'Your SR goal threshold (default: 2.0)', '2.0')
  .option('--my-irating <irating>', 'Your current iRating', '1200')
  .option('--position <pos>', 'Your starting position')
  .action(async (options) => {
    const client = new IRacingClient();
    await authenticateClient(client);

    const userProfile: UserProfile = {
      custId: process.env.IRACING_CUST_ID ? parseInt(process.env.IRACING_CUST_ID) : undefined,
      sr: parseFloat(options.mySr),
      srGoal: parseFloat(options.srGoal),
      irating: parseInt(options.myIrating),
      startingPosition: options.position ? parseInt(options.position) : undefined,
      goalDescription: `Maintain SR above ${options.srGoal}`,
    };

    console.log(`\nAnalyzing session ${options.sessionId}...`);

    try {
      const analysis = await analyzeRaceGrid(
        client,
        parseInt(options.sessionId),
        userProfile
      );

      console.log(formatGridAnalysis(analysis, userProfile));
    } catch (error: any) {
      console.error(`Analysis failed: ${error.message}`);
      process.exit(1);
    }
  });

/**
 * Look up a single driver's risk profile
 */
program
  .command('driver')
  .description('Analyze a single driver\'s risk profile')
  .requiredOption('--cust-id <id>', 'iRacing customer ID')
  .option('--races <count>', 'Number of recent races to analyze', '10')
  .action(async (options) => {
    const client = new IRacingClient();
    await authenticateClient(client);

    console.log(`\nAnalyzing driver ${options.custId}...`);

    try {
      const profile = await analyzeDriver(
        client,
        parseInt(options.custId),
        parseInt(options.races)
      );

      console.log('\n' + '='.repeat(50));
      console.log('           DRIVER RISK PROFILE');
      console.log('='.repeat(50));
      console.log(`\nDriver: ${profile.displayName}`);
      console.log(`iRating: ${profile.irating} | SR: ${profile.sr} | License: ${profile.licenseClass}`);
      console.log(`\nRisk Score: ${profile.riskScore}/10 (${profile.riskLevel})`);
      console.log(`Avg Incidents: ${profile.avgIncidentsPerRace} per race`);
      console.log(`Races Analyzed: ${profile.totalRacesAnalyzed}`);
      console.log(`SR Trend: ${profile.srTrend}`);

      console.log('\nIncident Timing:');
      console.log(`  - Lap 1-2: ${Math.round(profile.incidentTiming.lap1_2 * 100)}%`);
      console.log(`  - Mid-race: ${Math.round(profile.incidentTiming.midRace * 100)}%`);
      console.log(`  - Final lap: ${Math.round(profile.incidentTiming.finalLap * 100)}%`);

      if (profile.keyPatterns.length > 0) {
        console.log('\nKey Patterns:');
        for (const pattern of profile.keyPatterns) {
          console.log(`  - ${pattern}`);
        }
      }

      console.log(`\nRecommendation: ${profile.recommendation}`);
      console.log('\n' + '='.repeat(50));
    } catch (error: any) {
      console.error(`Analysis failed: ${error.message}`);
      process.exit(1);
    }
  });

/**
 * Test connection and fetch basic driver info
 */
program
  .command('test')
  .description('Test API connection and fetch basic driver info')
  .requiredOption('--cust-id <id>', 'iRacing customer ID to look up')
  .action(async (options) => {
    const client = new IRacingClient();
    await authenticateClient(client);

    console.log('Authentication successful!\n');

    try {
      console.log(`Fetching recent races for customer ID: ${options.custId}`);
      const recentRaces = await client.getRecentRaces(parseInt(options.custId));
      console.log(`Found ${recentRaces.length} recent races`);

      if (recentRaces.length > 0) {
        console.log('\n--- Recent Races ---');
        for (const race of recentRaces.slice(0, 5)) {
          console.log(`  ${race.seriesName} @ ${race.track.trackName}`);
          console.log(`    Finish: P${race.finishPosition} | Incidents: ${race.incidents}`);
          console.log(`    iRating: ${race.oldIrating} -> ${race.newIrating}`);
          console.log('');
        }
      }

      // Try to get driver info
      console.log('Fetching driver profile...');
      const driverInfo = await client.getDriverInfo(parseInt(options.custId));

      if (driverInfo) {
        console.log('\n--- Driver Info ---');
        console.log(`Name: ${driverInfo.displayName}`);
        console.log(`Customer ID: ${driverInfo.custId}`);

        if (driverInfo.licenses.length > 0) {
          console.log('\nLicenses:');
          for (const lic of driverInfo.licenses) {
            console.log(`  ${lic.categoryName}: ${lic.groupName} | SR ${lic.safetyRating.toFixed(2)} | iRating ${lic.irating}`);
          }
        }
      } else {
        console.log('Could not fetch driver profile (may require different endpoint)');
      }
    } catch (error: any) {
      console.error(`Error: ${error.message}`);
      process.exit(1);
    }
  });

/**
 * Build local cache of driver profiles
 */
program
  .command('build-cache')
  .description('Build local cache of driver profiles from recent races')
  .option('--last-races <count>', 'Number of your recent races to scan', '5')
  .action(async (options) => {
    console.log('Build cache functionality - coming soon');
    console.log(`Would scan last ${options.lastRaces} races for drivers`);
    // TODO: Implement cache building
  });

program.parse();
