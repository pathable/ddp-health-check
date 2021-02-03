const fs = require('fs');
const path = require('path');
const AWS = require('aws-sdk');
const { GraphQLClient } = require('graphql-request');
const Slack = require('slack');

const lambda = new AWS.Lambda();
const galaxyGraphQLClients = {};
const GALAXY_GRAPHQL_ENDPOINT_MAPPING = {
  'us-east-1': 'https://us-east-1.api.meteor.com/graphql',
  'eu-west-1': 'https://eu-west-1.api.meteor.com/graphql',
  'ap-southeast-2': 'https://ap-southeast-2.api.meteor.com/graphql',
};
const GALAXY_API_KEY_MAPPING = {
  'us-east-1': 'GALAXY_API_KEY_US',
  'eu-west-1': 'GALAXY_API_KEY_EU',
  'ap-southeast-2': 'GALAXY_API_KEY_AP',
};
// The number of maximum containers requested via the Galaxy GraphQL API
const GALAXY_GRAPHQL_CONTAINER_LIMIT = 500;

const getSettings = () => {
  const requiredParams = [
    'DDP_HEALTH_CHECK_APPS',
    'DDP_HEALTH_CHECK_KEY',
    'DDP_HEALTH_CHECK_DATADOG_METRIC_NAME',
    'DATADOG_API_KEY',
    'DATADOG_APP_KEY',
  ];
  const optionalParams = [
    'GALAXY_API_KEY_US',
    'GALAXY_API_KEY_EU',
    'GALAXY_API_KEY_AP',
    'DDP_HEALTH_CHECK_SLACK_TOKEN',
    'DDP_HEALTH_CHECK_SLACK_CHANNEL',
  ];
  const settingsFilePath = path.resolve('settings.json');
  const paramsFromFile = fs.existsSync(settingsFilePath)
    ? JSON.parse(fs.readFileSync(settingsFilePath))
    : {};
  const settings = {};

  // Populate params
  [...requiredParams, ...optionalParams].forEach(paramName => {
    // Prioritize params from local settings file over remote Serverless params
    let param = paramsFromFile[paramName] || process.env[paramName];
    if (paramName === 'DDP_HEALTH_CHECK_APPS' && typeof param === 'string')
      param = JSON.parse(param);
    settings[paramName] = param || null;
  });

  if (requiredParams.some(paramName => !settings[paramName]))
    throw new Error(`Missing required DDP health check settings`);
  if (!settings.DDP_HEALTH_CHECK_APPS || !settings.DDP_HEALTH_CHECK_APPS.length)
    throw new Error('Apps info not correctly defined');

  return settings;
};

const getGalaxyGraphQLClient = galaxyRegionName => {
  if (galaxyGraphQLClients[galaxyRegionName])
    return galaxyGraphQLClients[galaxyRegionName];

  const galaxyGraphQLEndpoint =
    GALAXY_GRAPHQL_ENDPOINT_MAPPING[galaxyRegionName];
  const galaxyAPIKey = getSettings()[GALAXY_API_KEY_MAPPING[galaxyRegionName]];

  if (!galaxyGraphQLEndpoint || !galaxyAPIKey)
    throw new Error(`Missing Galaxy API credentials for "${galaxyRegionName}"`);

  galaxyGraphQLClients[galaxyRegionName] = new GraphQLClient(
    galaxyGraphQLEndpoint,
    {
      headers: {
        'galaxy-api-key': galaxyAPIKey,
      },
    }
  );

  return galaxyGraphQLClients[galaxyRegionName];
};

module.exports.getSettings = getSettings;

module.exports.getGalaxyContainersInfoAsync = ({
  hostname,
  galaxyRegionName,
}) => {
  return getGalaxyGraphQLClient(galaxyRegionName).request(
    `
      query getGalaxyContainersInfo($hostname: String!, $containerLimit: Int!) {
        app(hostname: $hostname){
          hostname
          url
          containerType {
            _id
          }
          containers(limit: $containerLimit) {
            _id
            status
            up
            runningAt
          }
        }
      }
    `,
    { hostname, containerLimit: GALAXY_GRAPHQL_CONTAINER_LIMIT }
  );
};

module.exports.triggerDDPHealthCheckForAppAsync = async appQueryPromise => {
  const {
    DDP_HEALTH_CHECK_APPS,
    DDP_HEALTH_CHECK_SLACK_CHANNEL,
    DDP_HEALTH_CHECK_SLACK_TOKEN,
  } = getSettings();

  try {
    const appQueryResult = await appQueryPromise;
    const {
      containers,
      containerType: { _id: containerTypeId },
    } = appQueryResult.app;
    const allContainersCount = containers.length;
    const { hostname, url } = appQueryResult.app;
    const appSettings = DDP_HEALTH_CHECK_APPS.find(
      _appSettings => _appSettings.hostname === hostname
    );
    const appName = `${appSettings.app} (${
      appSettings.customRegionName || appSettings.galaxyRegionName
    })`;
    const NEW_CONTAINER_IGNORE_DURATION = 180000; // 3 mins
    // When a new container is initialized, it usually takes longer to respond to
    // DDP health check messages, which leads to response time values not accurately
    // reflecting the actual health of the container. So we wait for a period of
    // time before starting monitoring these fresh containers.
    // Note that each container's age is calculated from its `runningAt`, which
    // indicates the first time the container passes a Galaxy HTTP health check.
    const matureContainerFilterFn = container =>
      container.runningAt &&
      container.runningAt.length &&
      new Date() - new Date(container.runningAt) >=
        NEW_CONTAINER_IGNORE_DURATION;
    // We filter out unhealthy containers because we already know that their response
    // time will be slow. Eventually these containers will be automatically replaced
    // by Galaxy, so we don't want them to affect the general metrics landscape of
    // what we truly care about: healthy running containers.
    const healthyContainerFilterFn = container =>
      container.status === 'running';
    // Healthy containers marked for shutdown as part of a release cycle tend to
    // respond slowly to DDP requests, so we'll also ignore them.
    const livingContainerFilterFn = container => !container.shouldStop;
    const matureHealthyLivingContainers = containers.filter(
      container =>
        matureContainerFilterFn(container) &&
        healthyContainerFilterFn(container) &&
        livingContainerFilterFn(container)
    );

    console.info(`Checking containers of "${appName}"`, {
      allContainersCount,
      matureHealthyLivingContainers: matureHealthyLivingContainers.length,
      matureContainersCount: containers.filter(matureContainerFilterFn).length,
      healthyContainersCount: containers.filter(healthyContainerFilterFn)
        .length,
      livingContainersCount: containers.filter(livingContainerFilterFn).length,
    });

    // Post a warning if we've reached Galaxy GraphQL API containers limit
    if (allContainersCount >= GALAXY_GRAPHQL_CONTAINER_LIMIT) {
      const warning = `DDP HEALTH CHECK WARNING: CONTAINERS LIMIT REACHED FOR "${appName}":
        containerLimit: ${GALAXY_GRAPHQL_CONTAINER_LIMIT}
        allContainersCount: ${allContainersCount}
      `;

      console.warn(warning);

      if (DDP_HEALTH_CHECK_SLACK_CHANNEL && DDP_HEALTH_CHECK_SLACK_TOKEN) {
        await new Slack({
          token: DDP_HEALTH_CHECK_SLACK_TOKEN,
        }).chat.postMessage({
          channel: DDP_HEALTH_CHECK_SLACK_CHANNEL,
          text: warning,
        });
      }
    }

    // Invoke the sendDDPHealthCheckRequest Lambda function for *each* container.
    // This ensures that all DDP messages are sent from isolated environments and
    // won't affect each other.
    await Promise.all(
      matureHealthyLivingContainers.map(container =>
        lambda
          .invoke({
            FunctionName: 'sendDDPHealthCheckRequest',
            // Invoke asynchronously so that triggerDDPHealthCheck won't time out if
            // any sendDDPHealthCheckRequest invocation fails.
            InvocationType: 'Event',
            Payload: JSON.stringify({
              hostname,
              url,
              containerId: container._id,
              containerTypeId,
              containerStatus: container.status,
              containerIsUp: container.up,
            }),
          })
          .promise()
      )
    );
  } catch (error) {
    const errorMessage = 'An error occurred during DDP health check';

    console.error(errorMessage);
    console.error(error);

    if (DDP_HEALTH_CHECK_SLACK_CHANNEL && DDP_HEALTH_CHECK_SLACK_TOKEN) {
      // Skip Slack notification for rare networking glitches that prevents our
      // health check Lambda from connecting to the Galaxy GraphQL API
      if (
        error.response.error &&
        error.response.error.includes(
          "502 Bad Gateway: Registered endpoints failed to handle the request"
        )
      ) {
        return;
      }
            
      await new Slack({ token: DDP_HEALTH_CHECK_SLACK_TOKEN }).chat.postMessage(
        {
          channel: DDP_HEALTH_CHECK_SLACK_CHANNEL,
          text: `${errorMessage}\n\n${error}`,
        }
      );
    }
  }
};
