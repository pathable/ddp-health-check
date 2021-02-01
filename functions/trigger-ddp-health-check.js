/*
 *  Pull containers info from Galaxy and perform health check on each container
 */

const {
  getGalaxyContainersInfoAsync,
  triggerDDPHealthCheckForAppAsync,
  getSettings,
} = require('../utils');

// Fix an issue in graphql-request where cross-fetch cannot be imported correctly
global.fetch = require('cross-fetch');

module.exports.triggerDDPHealthCheck = async () => {
  const appQueryPromises = [];

  // Retrieve apps and their container info
  getSettings().DDP_HEALTH_CHECK_APPS.forEach(appSettings => {
    appQueryPromises.push(
      getGalaxyContainersInfoAsync({
        hostname: appSettings.hostname,
        galaxyRegionName: appSettings.galaxyRegionName,
        containerLimit: appSettings.containerLimit,
      })
    );
  });

  // Trigger DDP health check for each app
  await Promise.all(appQueryPromises.map(triggerDDPHealthCheckForAppAsync));

  return { statusCode: 200 };
};
