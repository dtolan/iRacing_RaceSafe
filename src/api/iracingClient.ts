import axios, { AxiosInstance } from 'axios';
import * as crypto from 'crypto';
import { IRacingRecentRace, IRacingLapData, IRacingDriverInfo } from '../types';

const BASE_URL = 'https://members-ng.iracing.com';
const OAUTH_URL = 'https://oauth.iracing.com/oauth2/token';

interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token?: string;
  refresh_token_expires_in?: number;
  scope?: string;
}

export class IRacingClient {
  private client: AxiosInstance;
  private accessToken: string | null = null;
  private refreshToken: string | null = null;
  private tokenExpiresAt: Date | null = null;
  private clientId: string | null = null;
  private clientSecret: string | null = null;

  constructor() {
    this.client = axios.create({
      headers: {
        'Content-Type': 'application/json',
      },
    });
  }

  /**
   * Mask a secret using SHA-256 hash with identifier
   * Per iRacing docs: normalize id (trim + lowercase), concatenate secret + id, SHA-256, base64
   */
  private maskSecret(secret: string, identifier: string): string {
    const normalizedId = identifier.trim().toLowerCase();
    const combined = secret + normalizedId;
    return crypto
      .createHash('sha256')
      .update(combined)
      .digest('base64');
  }

  /**
   * Authenticate using OAuth2 Password Limited flow
   * Requires client_id, client_secret, username (email), and password
   */
  async authenticate(
    username: string,
    password: string,
    clientId: string,
    clientSecret: string
  ): Promise<boolean> {
    try {
      this.clientId = clientId;
      this.clientSecret = clientSecret;

      // Mask credentials per iRacing requirements
      const maskedSecret = this.maskSecret(clientSecret, clientId);
      const maskedPassword = this.maskSecret(password, username);

      const params = new URLSearchParams({
        grant_type: 'password_limited',
        client_id: clientId,
        client_secret: maskedSecret,
        username: username,
        password: maskedPassword,
        scope: 'iracing.auth',
      });

      const response = await axios.post<TokenResponse>(OAUTH_URL, params.toString(), {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      });

      if (response.data?.access_token) {
        this.accessToken = response.data.access_token;
        this.refreshToken = response.data.refresh_token || null;
        this.tokenExpiresAt = new Date(Date.now() + (response.data.expires_in * 1000));

        console.log('Successfully authenticated with iRacing OAuth');
        console.log(`Token expires at: ${this.tokenExpiresAt.toLocaleTimeString()}`);
        return true;
      }

      console.error('Authentication failed - no access token received');
      return false;
    } catch (error: any) {
      if (error.response) {
        console.error('Authentication error:', error.response.status, error.response.data);
      } else {
        console.error('Authentication error:', error.message);
      }
      return false;
    }
  }

  /**
   * Refresh the access token using refresh token
   */
  async refreshAccessToken(): Promise<boolean> {
    if (!this.refreshToken || !this.clientId || !this.clientSecret) {
      console.error('Cannot refresh - missing refresh token or client credentials');
      return false;
    }

    try {
      const maskedSecret = this.maskSecret(this.clientSecret, this.clientId);

      const params = new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: this.clientId,
        client_secret: maskedSecret,
        refresh_token: this.refreshToken,
      });

      const response = await axios.post<TokenResponse>(OAUTH_URL, params.toString(), {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      });

      if (response.data?.access_token) {
        this.accessToken = response.data.access_token;
        this.refreshToken = response.data.refresh_token || this.refreshToken;
        this.tokenExpiresAt = new Date(Date.now() + (response.data.expires_in * 1000));

        console.log('Token refreshed successfully');
        return true;
      }

      return false;
    } catch (error: any) {
      console.error('Token refresh error:', error.message);
      return false;
    }
  }

  /**
   * Check if client is authenticated and token is valid
   */
  isAuthenticated(): boolean {
    if (!this.accessToken || !this.tokenExpiresAt) {
      return false;
    }
    // Add 60 second buffer before expiry
    return this.tokenExpiresAt.getTime() > (Date.now() + 60000);
  }

  /**
   * Ensure we have a valid token, refreshing if needed
   */
  private async ensureAuthenticated(): Promise<void> {
    if (!this.accessToken) {
      throw new Error('Not authenticated. Call authenticate() first.');
    }

    if (!this.isAuthenticated() && this.refreshToken) {
      const refreshed = await this.refreshAccessToken();
      if (!refreshed) {
        throw new Error('Token expired and refresh failed. Re-authenticate required.');
      }
    }
  }

  /**
   * Fetch data from iRacing API with link handling
   * iRacing returns a link object that points to the actual data
   */
  private async fetchData<T>(endpoint: string, params?: Record<string, any>): Promise<T> {
    await this.ensureAuthenticated();

    try {
      const response = await this.client.get(`${BASE_URL}${endpoint}`, {
        params,
        headers: {
          'Authorization': `Bearer ${this.accessToken}`,
        },
      });

      // iRacing returns a link object that points to the actual data (S3 signed URL)
      // Important: Do NOT send Authorization header to the S3 link - it's pre-signed
      if (response.data?.link) {
        const dataResponse = await this.client.get(response.data.link);
        return dataResponse.data;
      }

      return response.data;
    } catch (error: any) {
      if (error.response?.status === 401) {
        // Try refresh and retry once
        if (this.refreshToken) {
          const refreshed = await this.refreshAccessToken();
          if (refreshed) {
            return this.fetchData(endpoint, params);
          }
        }
      }
      throw new Error(`API request failed: ${error.response?.status || ''} ${error.message}`);
    }
  }

  /**
   * Get recent races for a driver
   */
  async getRecentRaces(custId: number): Promise<IRacingRecentRace[]> {
    const data = await this.fetchData<{ races: any[] }>('/data/stats/member_recent_races', {
      cust_id: custId,
    });

    return (data.races || []).map(this.mapRecentRace);
  }

  /**
   * Get lap data for a specific race/driver
   * simsession_number: 0 = race, -1 = qualifying, etc.
   */
  async getLapData(subsessionId: number, custId: number, simsessionNumber: number = 0): Promise<IRacingLapData[]> {
    const data = await this.fetchData<any>('/data/results/lap_data', {
      subsession_id: subsessionId,
      simsession_number: simsessionNumber,
      cust_id: custId,
    });

    // The response has the lap data in a nested structure
    const laps = data?.chunk_info?.chunk_file_names
      ? await this.fetchLapChunks(data)
      : (Array.isArray(data) ? data : []);

    return laps.map(this.mapLapData);
  }

  /**
   * Get lap chart data (alternative endpoint)
   */
  async getLapChartData(subsessionId: number, simsessionNumber: number = 0, custId?: number): Promise<any[]> {
    const params: any = {
      subsession_id: subsessionId,
      simsession_number: simsessionNumber,
    };
    if (custId) params.cust_id = custId;

    const data = await this.fetchData<any>('/data/results/lap_chart_data', params);

    // Check if data is chunked
    if (data?.chunk_info?.chunk_file_names) {
      return this.fetchLapChunks(data);
    }

    return Array.isArray(data) ? data : [];
  }

  /**
   * Fetch chunked lap data from S3
   */
  private async fetchLapChunks(data: any): Promise<any[]> {
    const baseUrl = data.chunk_info.base_download_url;
    const chunks = data.chunk_info.chunk_file_names || [];
    const allLaps: any[] = [];

    for (const chunkFile of chunks) {
      try {
        const chunkResponse = await this.client.get(`${baseUrl}${chunkFile}`);
        if (Array.isArray(chunkResponse.data)) {
          allLaps.push(...chunkResponse.data);
        }
      } catch (e) {
        // Skip failed chunks
      }
    }

    return allLaps;
  }

  /**
   * Get race results for a session
   */
  async getRaceResults(subsessionId: number): Promise<any> {
    return this.fetchData('/data/results/get', {
      subsession_id: subsessionId,
    });
  }

  /**
   * Search for race results by date range
   * This allows getting more than 10 races (which is the limit of member_recent_races)
   */
  async searchRaceResults(
    custId: number,
    startDate?: Date,
    endDate?: Date
  ): Promise<IRacingRecentRace[]> {
    const params: any = {
      cust_id: custId,
      official_only: true,
      event_types: 5, // 5 = race
    };

    if (startDate) {
      params.start_range_begin = startDate.toISOString();
    }
    if (endDate) {
      params.start_range_end = endDate.toISOString();
    }

    try {
      const data = await this.fetchData<any>('/data/results/search_series', params);

      // The response contains chunk info for large result sets
      let results: any[] = [];
      if (data?.data?.chunk_info?.chunk_file_names) {
        const baseUrl = data.data.chunk_info.base_download_url;
        for (const chunkFile of data.data.chunk_info.chunk_file_names) {
          try {
            const chunkResponse = await this.client.get(`${baseUrl}${chunkFile}`);
            if (Array.isArray(chunkResponse.data)) {
              results.push(...chunkResponse.data);
            }
          } catch (e) {
            // Skip failed chunks
          }
        }
      } else if (Array.isArray(data?.data)) {
        results = data.data;
      }

      return results.map((r: any) => ({
        subsessionId: r.subsession_id,
        sessionStartTime: r.start_time,
        track: {
          trackId: r.track?.track_id,
          trackName: r.track?.track_name,
        },
        licenseLevel: r.license_level,
        seriesId: r.series_id,
        seriesName: r.series_name,
        sessionType: 'Race',
        startPosition: r.start_position,
        finishPosition: r.finish_position,
        incidents: r.incidents,
        strengthOfField: r.strength_of_field,
        oldIrating: r.old_irating,
        newIrating: r.new_irating,
        oldSubLevel: r.old_sub_level,
        newSubLevel: r.new_sub_level,
        lapsComplete: r.laps_complete,
      }));
    } catch (error: any) {
      console.error('searchRaceResults error:', error.message);
      return [];
    }
  }

  /**
   * Get driver info/profile
   */
  async getDriverInfo(custId: number): Promise<IRacingDriverInfo | null> {
    try {
      const data = await this.fetchData<any>('/data/member/get', {
        cust_ids: custId,
        include_licenses: true,
      });

      if (data.members && data.members.length > 0) {
        return this.mapDriverInfo(data.members[0]);
      }
      return null;
    } catch (error: any) {
      console.error('getDriverInfo error:', error.message);
      return null;
    }
  }

  /**
   * Search for drivers by name
   */
  async searchDrivers(searchTerm: string): Promise<IRacingDriverInfo[]> {
    const data = await this.fetchData<{ searchRacers: any[] }>('/data/member/search', {
      search_term: searchTerm,
    });

    return (data.searchRacers || []).map(this.mapDriverInfo);
  }

  // Mapping functions to normalize API responses
  private mapRecentRace(race: any): IRacingRecentRace {
    return {
      subsessionId: race.subsession_id,
      sessionStartTime: race.session_start_time,
      track: {
        trackId: race.track?.track_id,
        trackName: race.track?.track_name,
      },
      licenseLevel: race.license_level,
      seriesId: race.series_id,
      seriesName: race.series_name,
      sessionType: race.session_type,
      startPosition: race.start_position,
      finishPosition: race.finish_position,
      incidents: race.incidents,
      strengthOfField: race.strength_of_field,
      oldIrating: race.oldi_rating,
      newIrating: race.newi_rating,
      oldSubLevel: race.old_sub_level,
      newSubLevel: race.new_sub_level,
      lapsComplete: race.laps,
    };
  }

  private mapLapData(lap: any): IRacingLapData {
    return {
      groupId: lap.group_id,
      name: lap.name,
      lapNumber: lap.lap_number,
      flags: lap.flags,
      incident: lap.incident,
      sessionTime: lap.session_time,
      lapTime: lap.lap_time,
      carNumber: lap.car_number,
    };
  }

  private mapDriverInfo(member: any): IRacingDriverInfo {
    return {
      custId: member.cust_id,
      displayName: member.display_name,
      licenses: (member.licenses || []).map((lic: any) => ({
        categoryId: lic.category_id,
        category: lic.category,
        categoryName: lic.category_name,
        licenseLevel: lic.license_level,
        safetyRating: lic.safety_rating,
        irating: lic.irating || 0,
        groupName: lic.group_name,
      })),
    };
  }
}

export const createClient = (): IRacingClient => new IRacingClient();
