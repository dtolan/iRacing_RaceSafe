import * as dotenv from 'dotenv';
import { IRacingClient } from '../api/iracingClient';

dotenv.config();

async function test() {
  const client = new IRacingClient();
  const email = process.env.IRACING_EMAIL!;
  const password = process.env.IRACING_PASSWORD!;
  const clientId = process.env.IRACING_CLIENT_ID!;
  const clientSecret = process.env.IRACING_CLIENT_SECRET!;

  await client.authenticate(email, password, clientId, clientSecret);

  // Test recent races (limited to 10)
  const races = await client.getRecentRaces(1247460);
  console.log(`member_recent_races returns: ${races.length} races`);

  // Test search results (should get more)
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  console.log('\nSearching for races in last 30 days...');
  const searchResults = await client.searchRaceResults(1247460, thirtyDaysAgo);
  console.log(`search_series returns: ${searchResults.length} races`);

  if (searchResults.length > 0) {
    console.log(`\nFirst race: ${searchResults[0].sessionStartTime}`);
    const lastIdx = searchResults.length - 1;
    console.log(`Last race: ${searchResults[lastIdx].sessionStartTime}`);
  }
}

test().catch(console.error);
