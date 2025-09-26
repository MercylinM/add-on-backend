#!/bin/bash
set -e

# Create dbus socket directory
mkdir -p /var/run/dbus

# Start dbus-daemon in system mode and background it
dbus-daemon --system --fork

# Start pulse audio server in system mode with required flags
pulseaudio --system --disallow-exit --exit-idle-time=-1 --log-target=syslog &

# Wait a few seconds for PulseAudio to start
sleep 3

# Run the container CMD 
exec "$@"
