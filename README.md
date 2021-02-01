# ddp-health-check

## Intro

ddp-health-check is a serverless script run on AWS Lambda that collects the DDP response
metrics of Meteor Galaxy containers and push those metrics to [Datadog](https://www.datadoghq.com).

The script periodically accesses pre-defined DDP endpoints and records response time,
which provides a consistent indicator that gives a general idea on how well your
containers are performing. This can serve as the big picture of your containers performance,
in addition to Meteor APM metrics which are more suitable for specific performance analysis
and tuning.

In order to avoid skewed data, ddp-health-check automatically filters out the following types
of containers whose response time may not accurately represent the general performance of
the cluster:
  - Fresh containers: Newly spawned containers take longer to respond to DDP requests.
    We wait until containers are at least 3 mins old before taking metrics from them.
  - Dying containers: Containers can be marked for shutdown either manually or automatically
    by Galaxy's internal container health check. These containers tend to respond slower to
    DDP requests, and we are not interested in collecting metrics from them because soon they
    will no longer be a part of the cluster.

**Intro of ddp-health-check at Meteor Impact**: https://youtu.be/GGBIuDJauYo?t=879

**A sample ddp-health-check dashboard**:

![sample dashboard](https://i.imgur.com/7AwIfSl.png)

## Setup

### Install Serverless

ddp-health-check uses the [Serverless](https://www.serverless.com) framework. To get started,
install and configure Serverless:

```bash
npm install serverless -g

npm install

serverless config credentials --provider aws --key AWS_ACCESS_KEY --secret AWS_SECRET_KEY
```

### Settings

Settings for ddp-health-check can be defined either as 
[Serverless parameters](https://www.serverless.com/framework/docs/guides/parameters) or in a `settings.json`
file.

*As Serverless parameters*:
![serverless parameters](https://i.imgur.com/uf5AjX0.png)

*As `settings.json`*:
```js
{
  // The Galaxy apps whose metrics you want to monitor. Defined as an array in settings.json,
  // or as a stringified array on Serverless parameters dashboard.
  "DDP_HEALTH_CHECK_APPS": [
    {
      // Galaxy app hostname
      "hostname": "app.example.com",
      // Galaxy region
      "galaxyRegionName": "us-east-1",
      // (Optional) Custom categorization of the app on Datadog (app, admin, jobs,...)
      "app": "main",
      // (Optional) Region name for custom grouping on Datadog
      "customRegionName": "us1"
    },
    {
      "hostname": "admin.example.com",
      "app": "admin",
      "galaxyRegionName": "eu-west-1",
      "customRegionName": "eu1"
    }
  ],  

  // Datadog API and app keys
  // https://docs.datadoghq.com/account_management/api-app-keys
  "DATADOG_API_KEY": "***",
  "DATADOG_APP_KEY": "***",  

  // Galaxy API keys (only keys for the regions of your apps are needed)
  "GALAXY_API_KEY_US": "***",
  "GALAXY_API_KEY_EU": "***",
  "GALAXY_API_KEY_AP": "***",  

  // (Optional) Used to secure DDP endpoints, default to "ddp-health-check-key"
  "DDP_HEALTH_CHECK_KEY": "ddp-health-check-key",

  // (Optional) Datadog metric name, default to "galaxy.container.ddp.latency"
  "DDP_HEALTH_CHECK_DATADOG_METRIC_NAME": "galaxy.container.ddp.latency",

  // (Optional) Slack token and channel for reporting issues
  // https://slack.com/intl/en-sg/help/articles/215770388-Create-and-regenerate-API-tokens
  "DDP_HEALTH_CHECK_SLACK_TOKEN": "***",
  "DDP_HEALTH_CHECK_SLACK_CHANNEL": "***"
}
```

### DDP Endpoints

In your Meteor app(s), define a method and a publication that ddp-health-check will connect to.
Both must be named `ddpHealthCheck`.

You may include custom computation logic in your method and publication that reflects a typical
task in your app.

These endpoints can be secured with an optional `DDP_HEALTH_CHECK_KEY` in settings.

```js
const validateHealthCheckRequest = key => {
  // Must be the same as DDP_HEALTH_CHECK_KEY in settings
  const healthCheckKey = 'ddp-health-check-key'; // default value
  if (healthCheckKey !== key)
    throw new Meteor.Error('Provided DDP health check key is invalid');
};

Meteor.methods({
  ddpHealthCheck(key) {
    validateHealthCheckRequest(key);

    /* Any custom computation logic here */

    // Must return the container id
    return process.env.GALAXY_CONTAINER_ID;
  },
});

Meteor.publish('ddpHealthCheck', function (key) {
  validateHealthCheckRequest(key);

  /* Any custom computation logic here */

  // Must publish the container id
  this.added('ddpHealthCheck', process.env.GALAXY_CONTAINER_ID);  

  this.ready()
});
```

### Deploy

`serverless deploy`

## Datadog

ddp-health-check submits metrics to Datadog under the name `galaxy.container.ddp.latency`.
You can define a custom name in `DDP_HEALTH_CHECK_DATADOG_METRIC_NAME`. Each record carries
a set of tags that can be used to filter data and design your Datadog dashboard:

```js
// Example tags on a particular metric record
hostname: "admin.example.com"
container: "glyzGhaHsx6a3met4-vmo2n"
type: "double-pro-v2"
app: "admin"
region: "us-east-1"
```

Some helpful resources:
- https://docs.datadoghq.com/metrics
- https://youtu.be/U5RmKDmGZM4?t=64

## Contributors

- Phuc Nguyen ([@npvn](https://github.com/npvn))
- Oli Oskarsson ([@oskarszoon](https://github.com/oskarszoon))