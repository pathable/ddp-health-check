/*
 *  Send requests to the DDP health check endpoints of the provided container,
 *  record response time and push to Datadog.
 */

const util = require('util');
const SimpleDDP = require('simpleddp');
const ws = require('isomorphic-ws');
const dogapi = require('dogapi');
const { getSettings } = require('../utils');

const dogapiMetricSendAsync = util.promisify(dogapi.metric.send);
let dogapiInitialized = false;

module.exports.sendDDPHealthCheckRequest = async containerInfo => {
  const { hostname, url, containerId, containerTypeId } = containerInfo;
  const {
    DDP_HEALTH_CHECK_APPS,
    DDP_HEALTH_CHECK_KEY,
    DDP_HEALTH_CHECK_DATADOG_METRIC_NAME,
    DATADOG_API_KEY,
    DATADOG_APP_KEY,
  } = getSettings();
  const {
    app,
    customRegionName,
    galaxyRegionName,
  } = DDP_HEALTH_CHECK_APPS.find(
    appSettings => appSettings.hostname === hostname
  );
  const websocketOptions = {
    endpoint: `${url.replace(
      'https',
      'wss'
    )}/websocket?_g_container_=${containerId}&_g_debug_=true`,
    SocketConstructor: ws,
    reconnectInterval: 5000,
  };
  let container;

  try {
    console.info(
      'Initializing DDP client and establishing connection to container',
      containerInfo
    );

    container = new SimpleDDP(websocketOptions);
    container.on('error', error =>
      console.info('SimpleDDP onError', {
        ...containerInfo,
        error,
      })
    );

    await container.connect();

    console.info('Connected to container. Doing method call...');

    // Health check method
    const methodCallStartTime = new Date();
    const containerIdFromMethod = await container.call(
      'ddpHealthCheck',
      DDP_HEALTH_CHECK_KEY
    );
    const methodCallEndTime = new Date();

    console.info('Method call finished. Doing subscription call...');

    // Health check sub
    const ddpHealthCheckSub = container.subscribe(
      'ddpHealthCheck',
      DDP_HEALTH_CHECK_KEY
    );
    await ddpHealthCheckSub.ready();
    const subEndTime = new Date();
    const containerRecordFromSub = container
      .collection('ddpHealthCheck')
      .fetch()[0];
    const containerIdFromSub =
      containerRecordFromSub && containerRecordFromSub.id;

    console.info('Subscription call finished. Disconnecting from container...');

    // Manually disconnect from the container, as the Lambda may take a while to
    // fully shutdown
    await container.disconnect();

    // Make sure we got data from the right container
    if (
      !containerIdFromMethod ||
      !containerIdFromSub ||
      containerIdFromMethod !== containerId ||
      containerIdFromSub !== containerId
    ) {
      console.error('Retrieved invalid container id', {
        ...containerInfo,
        containerIdFromMethod,
        containerIdFromSub,
      });
      return;
    }

    // Note: timestamp is second-based, while averageResponseTime is millisecond-based
    const timestamp = Math.trunc(methodCallStartTime.getTime() / 1000);
    const averageResponseTime = Math.trunc(
      (methodCallEndTime -
        methodCallStartTime +
        (subEndTime - methodCallEndTime)) /
        2
    );

    console.info('Disconnected. Sending metrics to Datadog...');

    if (!dogapiInitialized) {
      dogapi.initialize({
        api_key: DATADOG_API_KEY,
        app_key: DATADOG_APP_KEY,
      });
      dogapiInitialized = true;
    }

    const dogapiMetricSendResult = await dogapiMetricSendAsync(
      DDP_HEALTH_CHECK_DATADOG_METRIC_NAME,
      [[timestamp, averageResponseTime]],
      {
        tags: [
          `hostname:${hostname}`,
          `container:${containerId}`,
          `type:${containerTypeId}`,
          `app:${app}`,
          `region:${customRegionName || galaxyRegionName}`,
        ],
      }
    );

    console.info('DDP health check finished', {
      ...containerInfo,
      methodResponseTime: methodCallEndTime - methodCallStartTime,
      pubResponseTime: subEndTime - methodCallEndTime,
      averageResponseTime,
      timestamp,
      dogapiMetricSendResult,
    });

    return { statusCode: 200 };
  } catch (error) {
    console.error('An unexpected error occurred during DDP health check:', {
      ...containerInfo,
      error,
    });

    // Manually disconnect in case of error
    if (container && container.disconnect) {
      await container.disconnect();
    }
  }
};
