import { IRacingClient } from '../api/iracingClient';
import {
  DriverRiskProfile,
  IRacingRecentRace,
  IRacingLapData,
} from '../types';

export interface IncidentTiming {
  lap1_2: number;
  midRace: number;
  finalLap: number;
}

// Estimated incident type breakdown based on lap deltas
// Note: This is an estimate since we only see total incident points per lap
export interface IncidentTypeBreakdown {
  contact4x: number;     // Heavy contact (4x) - likely car-to-car
  lostControl2x: number; // Spins, wall hits (2x)
  offTrack1x: number;    // Off-track excursions (1x)
  total: number;
}

/**
 * Analyze a driver's risk profile based on their recent race history
 */
export async function analyzeDriver(
  client: IRacingClient,
  custId: number,
  numRaces: number = 20
): Promise<DriverRiskProfile> {
  // Get recent races - try search first (more data), fall back to member_recent_races
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  let races = await client.searchRaceResults(custId, thirtyDaysAgo);

  // Sort by date (most recent first) since search results may not be sorted
  races.sort((a, b) => new Date(b.sessionStartTime).getTime() - new Date(a.sessionStartTime).getTime());

  // Fall back to member_recent_races if search returned nothing
  if (races.length === 0) {
    races = await client.getRecentRaces(custId);
  }

  // Store total race count before slicing
  const totalRacesIn30Days = races.length;

  const racesToAnalyze = races.slice(0, numRaces);

  if (racesToAnalyze.length === 0) {
    throw new Error(`No recent races found for driver ${custId}`);
  }

  // Get driver info
  const driverInfo = await client.getDriverInfo(custId);
  const displayName = driverInfo?.displayName || `Driver ${custId}`;

  // Calculate average incidents using ALL races in 30 days, not just the subset
  const totalIncidents = races.reduce((sum, race) => sum + race.incidents, 0);
  const avgIncidents = totalIncidents / races.length;

  // Calculate recent stats (last 7 days)
  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
  const recentRacesData = races.filter(race => {
    const raceDate = new Date(race.sessionStartTime);
    return raceDate >= sevenDaysAgo;
  });
  const recentRaceCount = recentRacesData.length;
  const recentAvgIncidents = recentRaceCount > 0
    ? recentRacesData.reduce((sum, race) => sum + race.incidents, 0) / recentRaceCount
    : 0;

  // Last race incidents
  const lastRaceIncidents = races.length > 0 ? races[0].incidents : 0;

  // Analyze incident timing and types
  const incidentAnalysis = await analyzeIncidentTiming(client, racesToAnalyze, custId);
  const incidentTiming = incidentAnalysis.timing;
  const incidentTypes = incidentAnalysis.types;

  // Calculate SR trend
  const srTrend = calculateSRTrend(racesToAnalyze);

  // Calculate risk score
  const riskScore = calculateRiskScore(avgIncidents, incidentTiming);
  const riskLevel = classifyRisk(riskScore);

  // Identify key patterns (including incident types)
  const keyPatterns = identifyPatterns(avgIncidents, incidentTiming, srTrend, incidentTypes);

  // Generate recommendation
  const recommendation = generateRecommendation(riskLevel, keyPatterns);

  // Get license info - try Sports Car (5), then Road (2), then any with iRating
  // Category IDs: 1=Oval, 2=Road (old), 3=Dirt Oval, 4=Dirt Road, 5=Sports Car, 6=Formula Car
  const sportsCarLicense = driverInfo?.licenses.find(l => l.categoryId === 5);
  const formulaLicense = driverInfo?.licenses.find(l => l.categoryId === 6);
  const anyLicenseWithIrating = driverInfo?.licenses.find(l => l.irating > 0);
  const license = sportsCarLicense || formulaLicense || anyLicenseWithIrating;

  return {
    custId,
    displayName,
    irating: license?.irating || 0,
    licenseClass: license?.groupName || 'Unknown',
    sr: license?.safetyRating || 0, // API now returns as decimal (e.g., 2.72)
    avgIncidentsPerRace: Math.round(avgIncidents * 10) / 10,
    totalRacesAnalyzed: totalRacesIn30Days,
    recentRaces: recentRaceCount,
    recentAvgIncidents: Math.round(recentAvgIncidents * 10) / 10,
    lastRaceIncidents,
    incidentTiming,
    incidentTypes,
    riskScore,
    srTrend,
    riskLevel,
    keyPatterns,
    recommendation,
  };
}

interface IncidentAnalysisResult {
  timing: IncidentTiming;
  types: IncidentTypeBreakdown;
}

/**
 * Estimate incident types from a lap delta
 * Since we only see total points per lap, we estimate:
 * - 4 points = likely a 4x contact
 * - 3 points = likely 2x + 1x (stacked)
 * - 2 points = likely a 2x (spin/wall) or two 1x
 * - 1 point = definitely a 1x (off-track)
 */
function estimateIncidentTypes(lapDelta: number): { x4: number; x2: number; x1: number } {
  if (lapDelta <= 0) return { x4: 0, x2: 0, x1: 0 };

  // Work from highest to lowest
  let remaining = lapDelta;
  let x4 = 0, x2 = 0, x1 = 0;

  // 4x incidents (contact)
  while (remaining >= 4) {
    x4++;
    remaining -= 4;
  }

  // 2x incidents (spin/wall)
  while (remaining >= 2) {
    x2++;
    remaining -= 2;
  }

  // 1x incidents (off-track)
  x1 = remaining;

  return { x4, x2, x1 };
}

/**
 * Analyze when incidents occur during races (lap 1-2 vs mid-race vs final lap)
 * Also estimates incident types based on lap deltas
 */
async function analyzeIncidentTiming(
  client: IRacingClient,
  races: IRacingRecentRace[],
  custId: number
): Promise<IncidentAnalysisResult> {
  let lap1_2Incidents = 0;
  let midRaceIncidents = 0;
  let finalLapIncidents = 0;

  // Incident type counters
  let contact4x = 0;
  let lostControl2x = 0;
  let offTrack1x = 0;

  for (const race of races) {
    try {
      const lapData = await client.getLapData(race.subsessionId, custId);

      if (lapData.length === 0) continue;

      const totalLaps = lapData.length;

      for (let i = 1; i < lapData.length; i++) {
        // Calculate incidents on this lap (difference from previous)
        const lapIncidents = lapData[i].incident - lapData[i - 1].incident;

        if (lapIncidents <= 0) continue;

        const lapNumber = lapData[i].lapNumber;

        // Classify by timing
        if (lapNumber <= 2) {
          lap1_2Incidents += lapIncidents;
        } else if (lapNumber >= totalLaps - 1) {
          finalLapIncidents += lapIncidents;
        } else {
          midRaceIncidents += lapIncidents;
        }

        // Estimate incident types
        const types = estimateIncidentTypes(lapIncidents);
        contact4x += types.x4;
        lostControl2x += types.x2;
        offTrack1x += types.x1;
      }
    } catch (error) {
      // Skip races where lap data is unavailable
      continue;
    }
  }

  const totalTiming = lap1_2Incidents + midRaceIncidents + finalLapIncidents;
  const totalTypes = contact4x + lostControl2x + offTrack1x;

  const timing: IncidentTiming = totalTiming === 0
    ? { lap1_2: 0.33, midRace: 0.34, finalLap: 0.33 }
    : {
        lap1_2: Math.round((lap1_2Incidents / totalTiming) * 100) / 100,
        midRace: Math.round((midRaceIncidents / totalTiming) * 100) / 100,
        finalLap: Math.round((finalLapIncidents / totalTiming) * 100) / 100,
      };

  const types: IncidentTypeBreakdown = {
    contact4x,
    lostControl2x,
    offTrack1x,
    total: totalTypes,
  };

  return { timing, types };
}

/**
 * Calculate SR trend from recent races
 */
function calculateSRTrend(races: IRacingRecentRace[]): 'improving' | 'stable' | 'declining' {
  if (races.length < 3) return 'stable';

  // Compare SR from oldest to newest races
  const recentRaces = races.slice(0, 5);
  const srChanges: number[] = [];

  for (const race of recentRaces) {
    const change = race.newSubLevel - race.oldSubLevel;
    srChanges.push(change);
  }

  const avgChange = srChanges.reduce((sum, c) => sum + c, 0) / srChanges.length;

  if (avgChange > 5) return 'improving';
  if (avgChange < -5) return 'declining';
  return 'stable';
}

/**
 * Calculate risk score (0-10 scale)
 *
 * Factors:
 * - Average incidents per race (higher = riskier)
 * - Lap 1-2 incident rate (early aggression indicator)
 * - Final lap incident rate (desperation indicator)
 */
export function calculateRiskScore(avgIncidents: number, timing: IncidentTiming): number {
  // Base score from average incidents
  // 0-2 incidents = low risk (0-3)
  // 3-5 incidents = moderate risk (4-6)
  // 6+ incidents = high risk (7-10)
  let baseScore: number;

  if (avgIncidents <= 2) {
    baseScore = avgIncidents * 1.5;
  } else if (avgIncidents <= 5) {
    baseScore = 3 + (avgIncidents - 2) * 1.0;
  } else {
    baseScore = 6 + Math.min((avgIncidents - 5) * 0.8, 4);
  }

  // Adjust for timing patterns
  let timingModifier = 0;

  // Penalize lap 1-2 aggression (>40% incidents in first 2 laps)
  if (timing.lap1_2 > 0.4) {
    timingModifier += 1.5;
  } else if (timing.lap1_2 > 0.3) {
    timingModifier += 0.5;
  }

  // Penalize final lap desperation (>30% incidents in final lap)
  if (timing.finalLap > 0.3) {
    timingModifier += 1.0;
  } else if (timing.finalLap > 0.25) {
    timingModifier += 0.5;
  }

  const finalScore = Math.min(baseScore + timingModifier, 10.0);

  return Math.round(finalScore * 10) / 10;
}

/**
 * Convert numeric risk score to category
 */
export function classifyRisk(riskScore: number): 'LOW' | 'MODERATE' | 'HIGH' {
  if (riskScore < 4) return 'LOW';
  if (riskScore < 7) return 'MODERATE';
  return 'HIGH';
}

/**
 * Identify key behavior patterns from the data
 */
function identifyPatterns(
  avgIncidents: number,
  timing: IncidentTiming,
  srTrend: string,
  incidentTypes?: IncidentTypeBreakdown
): string[] {
  const patterns: string[] = [];

  // Incident rate patterns
  if (avgIncidents >= 8) {
    patterns.push(`Very high incident rate: ${avgIncidents.toFixed(1)} avg per race`);
  } else if (avgIncidents >= 6) {
    patterns.push(`High incident rate: ${avgIncidents.toFixed(1)} avg per race`);
  } else if (avgIncidents <= 2) {
    patterns.push(`Clean racer: ${avgIncidents.toFixed(1)} avg incidents per race`);
  }

  // Timing patterns
  if (timing.lap1_2 >= 0.5) {
    patterns.push(`T1 aggressor: ${Math.round(timing.lap1_2 * 100)}% of incidents in lap 1-2`);
  } else if (timing.lap1_2 >= 0.4) {
    patterns.push(`Lap 1 risk: ${Math.round(timing.lap1_2 * 100)}% of incidents early`);
  }

  if (timing.finalLap >= 0.4) {
    patterns.push(`Final lap desperado: ${Math.round(timing.finalLap * 100)}% of incidents in final lap`);
  } else if (timing.finalLap >= 0.3) {
    patterns.push(`Late race risk: ${Math.round(timing.finalLap * 100)}% of incidents near finish`);
  }

  // SR trend
  if (srTrend === 'declining') {
    patterns.push('Declining SR trend over recent races');
  } else if (srTrend === 'improving') {
    patterns.push('Improving SR trend - getting cleaner');
  }

  // Incident type patterns
  if (incidentTypes && incidentTypes.total > 0) {
    const contactRate = incidentTypes.contact4x / incidentTypes.total;
    const lostControlRate = incidentTypes.lostControl2x / incidentTypes.total;

    if (contactRate >= 0.5 && incidentTypes.contact4x >= 3) {
      patterns.push(`Contact-prone: ${incidentTypes.contact4x} heavy contacts (4x) - ${Math.round(contactRate * 100)}% of incidents`);
    } else if (incidentTypes.contact4x >= 5) {
      patterns.push(`High contact count: ${incidentTypes.contact4x} heavy contacts (4x)`);
    }

    if (lostControlRate >= 0.5 && incidentTypes.lostControl2x >= 3) {
      patterns.push(`Car control issues: ${incidentTypes.lostControl2x} spins/wall hits (2x) - ${Math.round(lostControlRate * 100)}% of incidents`);
    }

    if (incidentTypes.offTrack1x >= 10) {
      patterns.push(`Track limit issues: ${incidentTypes.offTrack1x} off-tracks (1x)`);
    }
  }

  return patterns;
}

/**
 * Generate strategic recommendation based on risk profile
 */
function generateRecommendation(riskLevel: string, patterns: string[]): string {
  const isT1Aggressor = patterns.some(p => p.includes('T1') || p.includes('Lap 1'));
  const isFinalLapRisk = patterns.some(p => p.includes('final lap') || p.includes('Late race'));

  if (riskLevel === 'HIGH') {
    if (isT1Aggressor) {
      return 'Avoid close racing in turn 1 - let them go, collect later';
    }
    if (isFinalLapRisk) {
      return 'Be extra cautious in final laps - maintain safe distance';
    }
    return 'Avoid wheel-to-wheel battles - let them pass if pressured';
  }

  if (riskLevel === 'MODERATE') {
    if (isT1Aggressor) {
      return 'Exercise caution at race start, safe to race mid-race';
    }
    return 'Reasonable to race with - stay alert but not overly cautious';
  }

  return 'Safe to race wheel-to-wheel - clean driver';
}

/**
 * Convert license level number to class letter
 */
function getLicenseClass(licenseLevel: number): string {
  if (licenseLevel >= 20) return 'A';
  if (licenseLevel >= 16) return 'B';
  if (licenseLevel >= 12) return 'C';
  if (licenseLevel >= 8) return 'D';
  return 'R';
}
