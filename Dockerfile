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
    bash \
    dbus

# Set the working directory
WORKDIR /app

# Copy project files
COPY . .

# Install project dependencies
RUN npm install

# Copy entrypoint script
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]


# Start application
CMD ["npm", "start"]


