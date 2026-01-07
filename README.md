# RaceSafe

AI-powered driver behavior analysis system for iRacing - pre-race risk assessment, real-time incident monitoring, and strategic guidance.

## What is RaceSafe?

RaceSafe is a background monitoring tool that helps you make informed decisions during iRacing sessions. It analyzes drivers in your session based on their historical data and alerts you to potential risks.

### Key Features

- **Pre-Race Grid Analysis**: Before the green flag, see a risk assessment of every driver in your session
- **Real-Time Incident Monitoring**: Get audio alerts when nearby drivers have incidents
- **Danger Zone Warnings**: Audio alerts when high-risk drivers are within 2 seconds of you
- **Session Type Detection**: Automatically detects Practice, Qualifying, Race, and Warmup sessions
- **Configurable Alerts**: Enable/disable alerts per session type
- **Windows Service Mode**: Runs invisibly in the background, auto-starts with Windows
- **Privacy-Focused**: Displays car numbers and statistics, not driver names

### How It Works

RaceSafe connects to the iRacing SDK to monitor your sessions. For each driver, it queries the iRacing API for:
- Recent race results and incident history
- Safety Rating trends
- Incident rate per race

Drivers are categorized into risk levels:
- **EXTREME**: Very high incident rates, exercise maximum caution
- **HIGH**: Above-average incident rates, maintain awareness
- **MODERATE**: Normal incident rates
- **LOW**: Clean drivers with minimal incidents

## Requirements

### System Requirements
- Windows 10 or later
- Node.js 18 or later
- iRacing subscription and installation

### iRacing API Credentials

RaceSafe requires iRacing OAuth2 credentials to access driver data. You'll need to request a **Password Limited** OAuth client from iRacing:

1. Go to [iRacing Forums](https://forums.iracing.com/) and search for "OAuth2" or visit the data API section
2. Request a Password Limited OAuth client (for personal use)
3. iRacing will provide you with:
   - Client ID (usually `{your_cust_id}-{app_name}`)
   - Client Secret

> **Note**: The Password Limited flow requires your iRacing email and password. These are only sent directly to iRacing's servers for authentication.

## Installation

### 1. Clone the Repository

```bash
git clone https://github.com/dtolan/iRacing_RaceSafe.git
cd iRacing_RaceSafe
```

### 2. Install Dependencies

```bash
npm install
```

### 3. Configure Environment

Create a `.env` file in the project root (copy from `.env.example` if available):

```env
# iRacing API Credentials
IRACING_EMAIL=your_email@example.com
IRACING_PASSWORD=your_password
IRACING_CUST_ID=your_customer_id
IRACING_CLIENT_ID=your_client_id
IRACING_CLIENT_SECRET=your_client_secret
```

### 4. Build the Project

```bash
npm run build
```

## Usage

### Manual Mode (Console)

Run RaceSafe manually for a single session:

```bash
npm run racesafe
```

This will:
1. Wait for iRacing to be running
2. Connect to your session
3. Display pre-race grid analysis
4. Monitor incidents and proximity alerts
5. Exit when you leave the session

### Windows Service Mode (Recommended)

Install RaceSafe as a Windows Service for persistent, automatic operation:

```bash
# Install the service (requires Administrator)
npm run service:install

# Check service status
npm run service:status

# Uninstall the service
npm run service:uninstall
```

**Service Features:**
- Starts automatically with Windows
- Runs invisibly in the background
- Auto-connects when iRacing launches
- Reconnects after iRacing closes
- Logs to `%APPDATA%\RaceSafe\logs\`

> **Note**: Service installation requires Administrator privileges. Right-click your terminal and select "Run as Administrator".

## Configuration

### Alert Settings

Configure which alerts play during each session type by adding to your `.env` file:

```env
# Alert Configuration per Session Type
# Set to "off" to disable, any other value (or missing) = enabled

# Practice session alerts
ALERTS_PRACTICE_DANGER=off      # Danger zone alerts during practice
ALERTS_PRACTICE_INCIDENT=on     # Incident alerts during practice

# Qualifying session alerts
ALERTS_QUALIFY_DANGER=on        # Danger zone alerts during qualifying
ALERTS_QUALIFY_INCIDENT=on      # Incident alerts during qualifying

# Race session alerts
ALERTS_RACE_DANGER=on           # Danger zone alerts during race
ALERTS_RACE_INCIDENT=on         # Incident alerts during race

# Warmup session alerts
ALERTS_WARMUP_DANGER=on         # Danger zone alerts during warmup
ALERTS_WARMUP_INCIDENT=on       # Incident alerts during warmup
```

**Default Behavior** (if not specified):
- All alerts are **enabled** by default
- Practice danger alerts are commonly disabled to reduce noise during practice

### Audio Alerts

RaceSafe uses Windows system sounds for alerts:
- **Danger Alert**: Hand sound - high-risk driver within 2 seconds
- **Warning Alert**: Exclamation sound - moderate risk nearby
- **Incident Alert**: Asterisk sound - driver near you had an incident
- **Clear Alert**: Default beep - previously flagged driver moved away

## Available Commands

| Command | Description |
|---------|-------------|
| `npm run racesafe` | Run RaceSafe in console mode |
| `npm run live` | Live session analysis |
| `npm run monitor` | In-race monitoring mode |
| `npm run last-race` | Analyze your most recent race |
| `npm run session` | Analyze a specific session |
| `npm run analyze` | CLI analysis tools |
| `npm run driver` | Look up a specific driver |
| `npm run service:install` | Install as Windows Service |
| `npm run service:uninstall` | Remove Windows Service |
| `npm run service:status` | Check service status |
| `npm run build` | Compile TypeScript |
| `npm run dev` | Run in development mode |

## Logs

When running as a Windows Service, logs are written to:
```
%APPDATA%\RaceSafe\logs\racesafe-YYYY-MM-DD.log
```

Logs are rotated daily and the last 7 days are retained.

To view logs:
```bash
# PowerShell
Get-Content "$env:APPDATA\RaceSafe\logs\racesafe-*.log" -Tail 50

# Or navigate to the folder
explorer "%APPDATA%\RaceSafe\logs"
```

## Understanding the Analysis

### Pre-Race Grid Display

```
=== PRE-RACE GRID ANALYSIS ===
#   Risk      Incidents  SR    Analysis
─────────────────────────────────────────────────────
12  EXTREME   8.5/race   1.2   Very high incident rate - maximum caution
 5  HIGH      4.2/race   2.8   Above average incidents
23  MODERATE  2.1/race   3.5   Normal incident rate
 8  LOW       0.8/race   4.2   Clean driver
```

### Risk Level Criteria

| Risk Level | Incident Rate | Description |
|------------|---------------|-------------|
| EXTREME | 6+ per race | Very high risk, avoid close racing |
| HIGH | 4-6 per race | Above average, maintain buffer |
| MODERATE | 2-4 per race | Normal, standard awareness |
| LOW | 0-2 per race | Clean, can race closely |

### Safety Rating vs Incident Count

> **Important Note**: A high Safety Rating doesn't always mean a clean driver. SR is calculated per corner, not per race. A driver who races frequently can maintain high SR while still having many incidents per race. RaceSafe looks at actual incident counts, not just SR.

## Troubleshooting

### Service Won't Install
- Ensure you're running as Administrator
- Run `npm run build` first to compile TypeScript
- Check that `dist/scripts/service.js` exists

### No Data for Drivers
- Verify your iRacing OAuth credentials in `.env`
- Ensure your OAuth client has API access
- Check that iRacing servers are online

### Audio Alerts Not Playing
- Ensure Windows system sounds are enabled
- Check that PowerShell is available
- Verify alert settings in `.env` aren't set to "off"

### Service Not Starting with iRacing
- Check service status: `npm run service:status`
- Review logs in `%APPDATA%\RaceSafe\logs\`
- Ensure iRacing is running before expecting connection

## Architecture

```
RaceSafe
├── src/
│   ├── api/           # iRacing API client
│   ├── analysis/      # Risk analysis algorithms
│   ├── scripts/       # Entry points (racesafe, service, install)
│   └── utils/         # Logger, helpers
├── dist/              # Compiled JavaScript
└── .env               # Configuration
```

## Future Plans

- **Web Dashboard**: Local HTTP server for post-race statistics and settings UI
- **Mobile Access**: View session data on your phone
- **OBS Integration**: Overlay source for streaming
- **Multi-User OAuth**: Simplified setup without per-user OAuth clients

## Contributing

Contributions are welcome! Please feel free to submit issues and pull requests.

## License

ISC License - See [LICENSE](LICENSE) for details.

## Disclaimer

RaceSafe is an independent project and is not affiliated with or endorsed by iRacing.com. Use at your own discretion. Driver analysis is based on historical data and should be used as one factor among many in your racing decisions.
