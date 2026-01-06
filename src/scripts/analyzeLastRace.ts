import * as dotenv from 'dotenv';
import { IRacingClient } from '../api/iracingClient';

dotenv.config();

async function analyzeLastRace() {
  const client = new IRacingClient();

  const email = process.env.IRACING_EMAIL!;
  const password = process.env.IRACING_PASSWORD!;
  const clientId = process.env.IRACING_CLIENT_ID!;
  const clientSecret = process.env.IRACING_CLIENT_SECRET!;

  console.log('Authenticating...');
  await client.authenticate(email, password, clientId, clientSecret);

  // Get recent races
  console.log('Fetching recent races...\n');
  const races = await client.getRecentRaces(1247460);
  const lastRace = races[0];

  console.log('='.repeat(50));
  console.log('           LAST RACE ANALYSIS');
  console.log('='.repeat(50));
  console.log(`\nSeries: ${lastRace.seriesName}`);
  console.log(`Track: ${lastRace.track.trackName}`);
  console.log(`Start Position: P${lastRace.startPosition}`);
  console.log(`Finish Position: P${lastRace.finishPosition}`);
  console.log(`Total Incidents: ${lastRace.incidents}x`);
  console.log(`iRating Change: ${lastRace.oldIrating} -> ${lastRace.newIrating} (${lastRace.newIrating - lastRace.oldIrating > 0 ? '+' : ''}${lastRace.newIrating - lastRace.oldIrating})`);
  console.log(`Subsession ID: ${lastRace.subsessionId}`);

  // Get lap chart data to analyze incidents lap by lap
  console.log('\nFetching lap chart data...');
  try {
    const lapChartData = await client.getLapChartData(lastRace.subsessionId, 0);

    // Filter for our driver
    const myLaps = lapChartData.filter((lap: any) => lap.cust_id === 1247460);

    if (myLaps.length > 0) {
      // Sort by lap number
      myLaps.sort((a: any, b: any) => a.lap_number - b.lap_number);

      console.log(`\nLaps completed: ${myLaps.length}`);
      console.log('\n--- LAP-BY-LAP BREAKDOWN ---\n');

      let prevIncidents = 0;
      let incidentLaps: { lap: number; points: number; cumulative: number; lapTime: string }[] = [];

      for (const lap of myLaps) {
        const lapIncidents = (lap.incident || 0) - prevIncidents;
        const lapTimeMs = lap.lap_time;
        const lapTimeStr = lapTimeMs > 0 ? `${(lapTimeMs / 10000).toFixed(3)}s` : 'N/A';

        // Show all laps with times
        let lapInfo = `  Lap ${lap.lap_number}: ${lapTimeStr}`;
        if (lap.lap_position) {
          lapInfo += ` (P${lap.lap_position})`;
        }

        if (lapIncidents > 0) {
          let incidentType = '';
          if (lapIncidents === 1) incidentType = '1x (off-track or minor contact)';
          else if (lapIncidents === 2) incidentType = '2x (off-track/lost control)';
          else if (lapIncidents === 4) incidentType = '4x (car contact)';
          else incidentType = `${lapIncidents}x`;

          lapInfo += ` *** +${incidentType} ***`;
          incidentLaps.push({
            lap: lap.lap_number,
            points: lapIncidents,
            cumulative: lap.incident || 0,
            lapTime: lapTimeStr
          });
        }

        // Check if first lap has incidents already
        if (lap.lap_number === 0 && (lap.incident || 0) > 0) {
          lapInfo += ` *** Started with ${lap.incident}x ***`;
          incidentLaps.push({
            lap: 0,
            points: lap.incident,
            cumulative: lap.incident,
            lapTime: lapTimeStr
          });
        }

        console.log(lapInfo);
        prevIncidents = lap.incident || 0;
      }

      console.log('\n--- INCIDENT SUMMARY ---');
      if (incidentLaps.length === 0) {
        console.log('  Clean race! No incidents recorded.');
      } else {
        for (const inc of incidentLaps) {
          console.log(`  Lap ${inc.lap}: +${inc.points}x (cumulative: ${inc.cumulative}x)`);
        }
      }
      console.log(`\n  Final Total: ${lastRace.incidents}x incident points`);
    } else {
      console.log('No lap data found for your driver');
    }

  } catch (error: any) {
    console.log('Could not fetch lap chart data:', error.message);
  }

  // Also get full race results for summary
  console.log('\nFetching full race results...');
  const results = await client.getRaceResults(lastRace.subsessionId);

  // Find the race session (simsession_type 6 = race)
  const raceSession = results.session_results?.find((s: any) => s.simsession_type === 6);
  if (raceSession) {
    // Find our driver
    const myResult = raceSession.results?.find((r: any) => r.cust_id === 1247460);
    if (myResult) {
      console.log('\n--- YOUR RACE RESULT ---');
      console.log(`Finish Position: P${myResult.finish_position}`);
      console.log(`Incidents: ${myResult.incidents}x`);
      console.log(`Laps Completed: ${myResult.laps_complete}`);
      console.log(`Average Lap Time: ${(myResult.average_lap / 10000).toFixed(3)}s`);
      console.log(`Best Lap Time: ${(myResult.best_lap_time / 10000).toFixed(3)}s`);
    }
  }

  console.log('\n' + '='.repeat(50));
}

analyzeLastRace().catch(console.error);
