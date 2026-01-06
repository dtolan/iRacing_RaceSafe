// RaceSafe - AI-powered driver behavior analysis for iRacing
// Main entry point for programmatic usage

export { IRacingClient, createClient } from './api/iracingClient';
export { analyzeDriver, calculateRiskScore, classifyRisk } from './analysis/riskAnalysis';
export { analyzeRaceGrid, formatGridAnalysis } from './analysis/gridAnalysis';
export * from './types';
