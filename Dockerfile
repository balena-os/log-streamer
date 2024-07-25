FROM node:20-alpine as build

# Defines our working directory in container
WORKDIR /usr/src/app

# Copies the package.json first for better cache on later pushes
COPY package*.json ./

RUN npm install

# # This will copy all files in our root to the working directory in the container
COPY . ./

# # Build dist
RUN npm run build

FROM node:20-alpine as prod

WORKDIR /usr/src/app

# This is a different image so copy package.json again
COPY package.json ./

# This installs npm dependencies on the balena build server,
# making sure to clean up the artifacts it creates in order to reduce the image size.
RUN JOBS=MAX npm install --omit=dev --unsafe-perm && npm cache verify && rm -rf /tmp/*

# Copy built files from the build stage
COPY --from=build /usr/src/app/build/ ./build

# server.js will run when container starts up on the device
CMD ["node", "build/index.js"]
