/**
 * RaceSafe Windows Service Installer
 *
 * Usage:
 *   npm run service:install   - Install and start the service
 *   npm run service:uninstall - Stop and remove the service
 */

import * as path from 'path';

// node-windows doesn't have TypeScript types, so we use require
const Service = require('node-windows').Service;

// Path to the compiled service entry point
const servicePath = path.join(__dirname, '..', '..', 'dist', 'scripts', 'service.js');

// Create a new service object
const svc = new Service({
  name: 'RaceSafe',
  description: 'iRacing driver risk monitoring and safety alerts',
  script: servicePath,
  nodeOptions: [],
  // Environment variables - these will be read from the service's working directory
  env: [
    {
      name: 'NODE_ENV',
      value: 'production',
    },
  ],
});

// Get the command from arguments
const command = process.argv[2];

if (command === 'install') {
  console.log('Installing RaceSafe service...');
  console.log(`Service script: ${servicePath}`);

  // Check if the script exists
  const fs = require('fs');
  if (!fs.existsSync(servicePath)) {
    console.error('\nError: Service script not found!');
    console.error('Please run "npm run build" first to compile the TypeScript files.');
    process.exit(1);
  }

  // Listen for install events
  svc.on('install', () => {
    console.log('\nService installed successfully!');
    console.log('Starting service...');
    svc.start();
  });

  svc.on('start', () => {
    console.log('Service started!');
    console.log('\nRaceSafe is now running as a Windows service.');
    console.log('It will start automatically when Windows boots.');
    console.log('\nLogs are written to: %APPDATA%\\RaceSafe\\logs\\');
    console.log('\nTo uninstall: npm run service:uninstall');
  });

  svc.on('alreadyinstalled', () => {
    console.log('Service is already installed.');
    console.log('To reinstall, first run: npm run service:uninstall');
  });

  svc.on('error', (err: any) => {
    console.error('Error:', err);
  });

  // Install the service
  svc.install();

} else if (command === 'uninstall') {
  console.log('Uninstalling RaceSafe service...');

  // Listen for uninstall events
  svc.on('uninstall', () => {
    console.log('Service uninstalled successfully!');
    console.log('\nRaceSafe service has been removed.');
    console.log('You can still run RaceSafe manually with: npm run racesafe');
  });

  svc.on('stop', () => {
    console.log('Service stopped.');
  });

  svc.on('error', (err: any) => {
    console.error('Error:', err);
  });

  // Uninstall the service
  svc.uninstall();

} else if (command === 'status') {
  // Check if service exists
  const { execSync } = require('child_process');
  try {
    const result = execSync('sc query RaceSafe', { encoding: 'utf8' });
    console.log('RaceSafe Service Status:');
    console.log(result);
  } catch (e) {
    console.log('RaceSafe service is not installed.');
  }

} else {
  console.log('RaceSafe Service Manager');
  console.log('========================');
  console.log('\nUsage:');
  console.log('  npm run service:install   - Install and start the service');
  console.log('  npm run service:uninstall - Stop and remove the service');
  console.log('  npm run service:status    - Check service status');
  console.log('\nNote: Administrator privileges are required for service management.');
}
