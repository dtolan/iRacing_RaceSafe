import { IRacingClient } from '../api/iracingClient';
import { analyzeDriver } from './riskAnalysis';
import {
  RaceSessionAnalysis,
  GridEntry,
  DriverRiskProfile,
  UserProfile,
} from '../types';

/**
 * Analyze an entire race grid and provide strategic recommendations
 */
export async function analyzeRaceGrid(
  client: IRacingClient,
  sessionId: number,
  userProfile: UserProfile
): Promise<RaceSessionAnalysis> {
  // Get race results/entry list
  const raceResults = await client.getRaceResults(sessionId);

  if (!raceResults) {
    throw new Error(`Could not fetch results for session ${sessionId}`);
  }

  // Extract session info
  const sessionInfo = raceResults.session_info || {};
  const series = raceResults.series_name || 'Unknown Series';
  const track = sessionInfo.track?.track_name || 'Unknown Track';
  const sof = raceResults.event_strength_of_field || 0;

  // Get driver list from results
  const sessionResults = raceResults.session_results || [];
  const raceSession = sessionResults.find((s: any) => s.simsession_type === 6) || sessionResults[0];
  const drivers = raceSession?.results || [];

  // Analyze each driver
  const grid: GridEntry[] = [];
  let highRiskCount = 0;
  let cleanCount = 0;
  let totalRiskScore = 0;
  let analyzedCount = 0;

  console.log(`\nAnalyzing ${drivers.length} drivers...`);

  for (const driver of drivers) {
    const custId = driver.cust_id;
    const position = driver.finish_position || driver.starting_position || grid.length + 1;
    const displayName = driver.display_name || `Driver ${custId}`;

    let riskProfile: DriverRiskProfile | null = null;

    try {
      // Skip analysis of user's own profile if custId matches
      if (userProfile.custId && custId === userProfile.custId) {
        console.log(`  P${position}: ${displayName} (YOU)`);
        grid.push({ position, custId, displayName, riskProfile: null });
        continue;
      }

      riskProfile = await analyzeDriver(client, custId, 10);
      totalRiskScore += riskProfile.riskScore;
      analyzedCount++;

      if (riskProfile.riskLevel === 'HIGH') {
        highRiskCount++;
        console.log(`  P${position}: ${displayName} - HIGH RISK (${riskProfile.riskScore})`);
      } else if (riskProfile.riskLevel === 'LOW') {
        cleanCount++;
        console.log(`  P${position}: ${displayName} - Clean (${riskProfile.riskScore})`);
      } else {
        console.log(`  P${position}: ${displayName} - Moderate (${riskProfile.riskScore})`);
      }
    } catch (error) {
      console.log(`  P${position}: ${displayName} - Analysis failed`);
    }

    grid.push({
      position,
      custId,
      displayName,
      riskProfile,
    });
  }

  // Calculate overall risk score
  const overallRiskScore = analyzedCount > 0
    ? Math.round((totalRiskScore / analyzedCount) * 10) / 10
    : 5;

  // Determine recommendation based on user's SR goal
  const recommendation = generateGridRecommendation(
    overallRiskScore,
    highRiskCount,
    userProfile
  );

  return {
    sessionId,
    series,
    track,
    strengthOfField: sof,
    grid,
    analysis: {
      overallRiskScore,
      highRiskDrivers: highRiskCount,
      cleanDrivers: cleanCount,
      recommendation,
    },
  };
}

/**
 * Generate overall grid recommendation based on analysis and user goals
 */
function generateGridRecommendation(
  overallRisk: number,
  highRiskCount: number,
  userProfile: UserProfile
): 'CONSERVATIVE' | 'MODERATE' | 'AGGRESSIVE' {
  // If user is close to SR demotion threshold, be more conservative
  const srBuffer = userProfile.sr - userProfile.srGoal;
  const srAtRisk = srBuffer < 0.2;

  if (srAtRisk && overallRisk >= 5) {
    return 'CONSERVATIVE';
  }

  if (overallRisk >= 7 || highRiskCount >= 5) {
    return 'CONSERVATIVE';
  }

  if (overallRisk >= 5 || highRiskCount >= 3) {
    return 'MODERATE';
  }

  return 'AGGRESSIVE';
}

/**
 * Format grid analysis for console output
 */
export function formatGridAnalysis(
  analysis: RaceSessionAnalysis,
  userProfile: UserProfile
): string {
  const lines: string[] = [];

  lines.push('');
  lines.push('='.repeat(60));
  lines.push('                    RACE ANALYSIS');
  lines.push('='.repeat(60));
  lines.push('');
  lines.push(`Session: ${analysis.series} @ ${analysis.track}`);
  lines.push(`Strength of Field: ${analysis.strengthOfField}`);
  lines.push(`Grid Size: ${analysis.grid.length} drivers`);
  lines.push('');
  lines.push(`OVERALL RISK: ${analysis.analysis.overallRiskScore}/10 (${getRiskLabel(analysis.analysis.overallRiskScore)})`);
  lines.push('');

  // High risk drivers
  const highRiskDrivers = analysis.grid.filter(
    g => g.riskProfile?.riskLevel === 'HIGH'
  );

  if (highRiskDrivers.length > 0) {
    lines.push('HIGH RISK DRIVERS (Avoid if possible):');
    for (const driver of highRiskDrivers) {
      const profile = driver.riskProfile!;
      const patterns = profile.keyPatterns.slice(0, 2).join(', ');
      lines.push(`  - P${driver.position}: ${driver.displayName}`);
      lines.push(`    Risk: ${profile.riskScore}/10 | ${profile.avgIncidentsPerRace} avg incidents`);
      if (patterns) {
        lines.push(`    ${patterns}`);
      }
    }
    lines.push('');
  }

  // Clean drivers
  const cleanDrivers = analysis.grid.filter(
    g => g.riskProfile?.riskLevel === 'LOW'
  );

  if (cleanDrivers.length > 0) {
    lines.push('CLEAN RACERS (Safe to battle):');
    for (const driver of cleanDrivers.slice(0, 5)) {
      const profile = driver.riskProfile!;
      lines.push(`  - P${driver.position}: ${driver.displayName} (${profile.avgIncidentsPerRace} avg incidents)`);
    }
    lines.push('');
  }

  // Strategic recommendation
  lines.push('-'.repeat(60));
  lines.push('STRATEGIC RECOMMENDATION');
  lines.push('-'.repeat(60));
  lines.push('');
  lines.push(`Your SR: ${userProfile.sr} (Goal: maintain above ${userProfile.srGoal})`);
  lines.push(`Starting Position: P${userProfile.startingPosition || '?'}`);
  lines.push('');
  lines.push(`Recommended Approach: ${analysis.analysis.recommendation}`);
  lines.push('');

  // Detailed advice based on recommendation
  switch (analysis.analysis.recommendation) {
    case 'CONSERVATIVE':
      lines.push('Strategy:');
      lines.push('  - Let high-risk drivers settle in first 3 laps');
      lines.push('  - Avoid wheel-to-wheel battles unless against clean racers');
      lines.push('  - Prioritize finishing clean over positions');
      lines.push('  - Keep safe distance in braking zones');
      break;
    case 'MODERATE':
      lines.push('Strategy:');
      lines.push('  - Race normally but stay alert around flagged drivers');
      lines.push('  - Push for positions against clean racers');
      lines.push('  - Exercise caution on lap 1 and final laps');
      break;
    case 'AGGRESSIVE':
      lines.push('Strategy:');
      lines.push('  - Field is relatively clean - race for positions');
      lines.push('  - Good opportunity to gain iRating');
      lines.push('  - Still maintain awareness of any flagged drivers');
      break;
  }

  lines.push('');
  lines.push('='.repeat(60));

  return lines.join('\n');
}

function getRiskLabel(score: number): string {
  if (score >= 7) return 'HIGH RISK RACE';
  if (score >= 5) return 'MODERATE RISK';
  return 'LOW RISK';
}
