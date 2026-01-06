import * as dotenv from 'dotenv';
import { IRacingClient } from '../api/iracingClient';
import { analyzeDriver } from '../analysis/riskAnalysis';

dotenv.config();

async function analyzeSession() {
  const subsessionId = process.argv[2];
  const myCustId = 1247460;

  if (!subsessionId) {
    console.log('Usage: npx ts-node src/scripts/analyzeSession.ts <subsession_id>');
    console.log('\nTo find your subsession_id:');
    console.log('  1. Join the race session (practice/qualify/race)');
    console.log('  2. Look at the URL in iRacing member site, or');
    console.log('  3. Check your recent races after joining');
    process.exit(1);
  }

  const client = new IRacingClient();

  const email = process.env.IRACING_EMAIL!;
  const password = process.env.IRACING_PASSWORD!;
  const clientId = process.env.IRACING_CLIENT_ID!;
  const clientSecret = process.env.IRACING_CLIENT_SECRET!;

  console.log('Authenticating...');
  await client.authenticate(email, password, clientId, clientSecret);

  console.log(`\nFetching session ${subsessionId}...`);

  try {
    const results = await client.getRaceResults(parseInt(subsessionId));

    console.log('\n' + '='.repeat(60));
    console.log('              PRE-RACE GRID ANALYSIS');
    console.log('='.repeat(60));
    console.log(`\nSeries: ${results.series_name}`);
    console.log(`Track: ${results.track?.track_name}`);
    console.log(`Strength of Field: ${results.event_strength_of_field}`);

    // Find the race or practice session
    const session = results.session_results?.find((s: any) =>
      s.simsession_type === 6 || s.simsession_type === 3
    ) || results.session_results?.[0];

    if (!session?.results) {
      console.log('\nNo driver data found in session yet.');
      console.log('The session may not have started, or results not available.');
      process.exit(0);
    }

    const drivers = session.results;
    console.log(`\nDrivers in session: ${drivers.length}`);

    // Analyze each driver
    console.log('\n--- ANALYZING DRIVERS ---\n');

    interface DriverAnalysis {
      position: number;
      custId: number;
      name: string;
      irating: number;
      riskScore: number;
      riskLevel: string;
      avgIncidents: number;
      patterns: string[];
      isMe: boolean;
    }

    const analyses: DriverAnalysis[] = [];

    for (const driver of drivers) {
      const custId = driver.cust_id;
      const name = driver.display_name;
      const position = driver.starting_position || driver.finish_position;

      if (custId === myCustId) {
        console.log(`  P${position}: ${name} (YOU)`);
        analyses.push({
          position,
          custId,
          name,
          irating: driver.oldi_rating || 0,
          riskScore: 0,
          riskLevel: 'YOU',
          avgIncidents: 0,
          patterns: [],
          isMe: true
        });
        continue;
      }

      try {
        const profile = await analyzeDriver(client, custId, 10);
        console.log(`  P${position}: ${name} - ${profile.riskLevel} (${profile.riskScore}/10)`);

        analyses.push({
          position,
          custId,
          name,
          irating: profile.irating,
          riskScore: profile.riskScore,
          riskLevel: profile.riskLevel,
          avgIncidents: profile.avgIncidentsPerRace,
          patterns: profile.keyPatterns,
          isMe: false
        });
      } catch (e) {
        console.log(`  P${position}: ${name} - Unable to analyze`);
        analyses.push({
          position,
          custId,
          name,
          irating: driver.oldi_rating || 0,
          riskScore: -1,
          riskLevel: 'UNKNOWN',
          avgIncidents: 0,
          patterns: [],
          isMe: false
        });
      }
    }

    // Sort by position
    analyses.sort((a, b) => a.position - b.position);

    // Summary
    const highRisk = analyses.filter(a => a.riskLevel === 'HIGH');
    const moderate = analyses.filter(a => a.riskLevel === 'MODERATE');
    const lowRisk = analyses.filter(a => a.riskLevel === 'LOW');

    console.log('\n' + '='.repeat(60));
    console.log('              RISK SUMMARY');
    console.log('='.repeat(60));

    const avgRisk = analyses
      .filter(a => a.riskScore >= 0 && !a.isMe)
      .reduce((sum, a) => sum + a.riskScore, 0) /
      analyses.filter(a => a.riskScore >= 0 && !a.isMe).length;

    console.log(`\nOverall Grid Risk: ${avgRisk.toFixed(1)}/10`);
    console.log(`High Risk Drivers: ${highRisk.length}`);
    console.log(`Moderate Risk: ${moderate.length}`);
    console.log(`Low Risk (Clean): ${lowRisk.length}`);

    if (highRisk.length > 0) {
      console.log('\n--- HIGH RISK DRIVERS (AVOID) ---');
      for (const d of highRisk) {
        console.log(`\n  P${d.position}: ${d.name}`);
        console.log(`    Risk: ${d.riskScore}/10 | Avg Incidents: ${d.avgIncidents}`);
        if (d.patterns.length > 0) {
          console.log(`    ${d.patterns[0]}`);
        }
      }
    }

    if (lowRisk.length > 0) {
      console.log('\n--- CLEAN RACERS (SAFE TO BATTLE) ---');
      for (const d of lowRisk.slice(0, 5)) {
        console.log(`  P${d.position}: ${d.name} (${d.avgIncidents} avg incidents)`);
      }
    }

    // Strategic recommendation
    console.log('\n--- STRATEGIC RECOMMENDATION ---');
    if (avgRisk >= 6) {
      console.log('  CONSERVATIVE approach recommended');
      console.log('  - Let the field settle in first 2-3 laps');
      console.log('  - Avoid wheel-to-wheel with flagged drivers');
      console.log('  - Prioritize clean finish over positions');
    } else if (avgRisk >= 4) {
      console.log('  MODERATE approach recommended');
      console.log('  - Race normally but stay alert');
      console.log('  - Watch flagged drivers closely');
      console.log('  - Good opportunity for positions if careful');
    } else {
      console.log('  AGGRESSIVE approach possible');
      console.log('  - Field is relatively clean');
      console.log('  - Good opportunity for iRating gains');
      console.log('  - Race hard but fair');
    }

    console.log('\n' + '='.repeat(60));

  } catch (error: any) {
    console.error('Error:', error.message);
    console.log('\nThe session may not be available yet.');
    console.log('Try again once practice or qualifying has started.');
  }
}

analyzeSession().catch(console.error);
