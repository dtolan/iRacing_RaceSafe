// Driver Risk Profile
export interface DriverRiskProfile {
  custId: number;
  displayName: string;
  irating: number;
  licenseClass: string;
  sr: number;

  // Incident statistics (last N races)
  avgIncidentsPerRace: number;
  totalRacesAnalyzed: number;

  // Recent stats (last 7 days)
  recentRaces: number;
  recentAvgIncidents: number;

  // Last race stats
  lastRaceIncidents: number;

  // Incident timing breakdown
  incidentTiming: {
    lap1_2: number;    // Percentage of incidents in first 2 laps
    midRace: number;   // Percentage mid-race
    finalLap: number;  // Percentage in final lap
  };

  // Estimated incident type breakdown (based on lap deltas)
  incidentTypes: {
    contact4x: number;     // Heavy contact count (4x)
    lostControl2x: number; // Spins/wall hits count (2x)
    offTrack1x: number;    // Off-track count (1x)
    total: number;
  };

  // Derived metrics
  riskScore: number;        // 0-10 scale (higher = riskier)
  srTrend: 'improving' | 'stable' | 'declining';
  riskLevel: 'LOW' | 'MODERATE' | 'HIGH';

  // Key patterns identified
  keyPatterns: string[];
  recommendation: string;
}

// Race Session Analysis
export interface RaceSessionAnalysis {
  sessionId: number;
  series: string;
  track: string;
  strengthOfField: number;

  grid: GridEntry[];

  analysis: {
    overallRiskScore: number;     // 0-10 scale
    highRiskDrivers: number;       // Count
    cleanDrivers: number;
    recommendation: 'CONSERVATIVE' | 'MODERATE' | 'AGGRESSIVE';
  };
}

export interface GridEntry {
  position: number;
  custId: number;
  displayName: string;
  riskProfile: DriverRiskProfile | null;
}

// iRacing API Response Types
export interface IRacingRecentRace {
  subsessionId: number;
  sessionStartTime: string;
  track: {
    trackId: number;
    trackName: string;
  };
  licenseLevel: number;
  seriesId: number;
  seriesName: string;
  sessionType: string;
  startPosition: number;
  finishPosition: number;
  incidents: number;
  strengthOfField: number;
  oldIrating: number;
  newIrating: number;
  oldSubLevel: number;
  newSubLevel: number;
  lapsComplete: number;
}

export interface IRacingLapData {
  groupId: number;
  name: string;
  lapNumber: number;
  flags: number;
  incident: number;  // Cumulative incidents up to this lap
  sessionTime: number;
  lapTime: number;
  carNumber: string;
}

export interface IRacingDriverInfo {
  custId: number;
  displayName: string;
  licenses: {
    categoryId: number;
    category: string;
    categoryName: string;
    licenseLevel: number;
    safetyRating: number;
    irating: number;
    groupName: string;  // "Rookie", "Class D", "Class C", "Class B", "Class A", "Pro"
  }[];
}

// User Profile for analysis context
export interface UserProfile {
  custId?: number;
  sr: number;
  srGoal: number;
  irating: number;
  startingPosition?: number;
  goalDescription: string;
}

// CLI Command Options
export interface AnalyzeOptions {
  sessionId: string;
  mySr: string;
  myGoal?: string;
}

export interface DriverLookupOptions {
  custId: string;
  races?: string;
}

export interface BuildCacheOptions {
  lastRaces?: string;
}
