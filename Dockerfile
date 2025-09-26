# Use the official Node.js runtime as the base image
FROM node:18-alpine

# Install system dependencies
RUN apk update && apk add --no-cache pulseaudio sox libsox-fmt-all pulseaudio-utils

# Set the working directory in the container
WORKDIR /usr/src/app

# Copy package.json and package-lock.json (if available)
COPY package*.json ./

# Install app dependencies
RUN npm install

# Copy the rest of the application code
COPY . .

# Expose the port the app runs on
EXPOSE 3000

# Define the command to run the application
CMD [ "npm", "start" ]