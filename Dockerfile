# Use Alpine Node base image
FROM node:18-alpine

# Install PulseAudio, Sox, ALSA and related utilities
RUN apk update && apk add --no-cache \
    pulseaudio \
    sox \
    pulseaudio-utils \
    alsa-utils \
    alsa-lib \
    alsa-plugins-pulse \
    bash

# Set the working directory
WORKDIR /app

# Copy project files
COPY . .

# Install project dependencies
RUN npm install

# Set environment variables for PulseAudio socket if needed
ENV PULSE_SERVER=unix:/run/user/1001/pulse/native

# Start your application
CMD ["npm", "start"]
