/**
 * AgentForEach Infrastructure — alerts
 *
 * The failures that matter at scale, each as an Azure Monitor alert:
 *
 *   - Errors: exceptions and error-level log lines (the Function App's 5xx)
 *   - Rate-limit bursts (abuse, or a client retrying in a loop)
 *   - Web PubSub connection quota nearly used up (add units)
 *   - Cosmos DB throttling (429 from the data plane)
 *   - Turns failing on their deadline or a stalled provider stream
 *
 * Alerts go to an email action group when `agentforeach:alertEmail` is set;
 * without it they still fire and show in the portal.
 */

import * as insights from "@pulumi/azure-native/insights";
import * as pulumi from "@pulumi/pulumi";

export function createAlerts(args: {
  resourceGroupName: pulumi.Input<string>;
  /** Short prefix for alert names (e.g. the stack name). */
  prefix: string;
  functionAppId: pulumi.Input<string>;
  webPubSubId: pulumi.Input<string>;
  cosmosAccountId: pulumi.Input<string>;
  appInsightsId: pulumi.Input<string>;
  location: pulumi.Input<string>;
  alertEmail?: string;
  tags: Record<string, string>;
}) {
  const actionGroup = args.alertEmail
    ? new insights.ActionGroup(`${args.prefix}-alerts`, {
        resourceGroupName: args.resourceGroupName,
        location: "Global",
        groupShortName: "afe-alerts",
        enabled: true,
        emailReceivers: [{ name: "operator", emailAddress: args.alertEmail, useCommonAlertSchema: true }],
        tags: args.tags,
      })
    : undefined;
  const actions = actionGroup ? [{ actionGroupId: actionGroup.id }] : [];

  const metricAlert = (
    name: string,
    description: string,
    scope: pulumi.Input<string>,
    criterion: {
      metricNamespace: string;
      metricName: string;
      timeAggregation: string;
      operator: string;
      threshold: number;
      dimensions?: Array<{ name: string; operator: string; values: string[] }>;
    },
    severity = 2,
  ) =>
    new insights.MetricAlert(`${args.prefix}-${name}`, {
      resourceGroupName: args.resourceGroupName,
      location: "global",
      description,
      severity,
      enabled: true,
      scopes: [scope],
      evaluationFrequency: "PT1M",
      windowSize: "PT5M",
      criteria: {
        odataType: "Microsoft.Azure.Monitor.SingleResourceMultipleMetricCriteria",
        allOf: [{ criterionType: "StaticThresholdCriterion", name: name, ...criterion }],
      },
      actions,
      tags: args.tags,
    });

  const logAlert = (name: string, description: string, query: string, threshold: number, severity = 2) =>
    new insights.ScheduledQueryRule(`${args.prefix}-${name}`, {
      resourceGroupName: args.resourceGroupName,
      location: args.location,
      kind: "LogAlert",
      description,
      severity,
      enabled: true,
      scopes: [args.appInsightsId],
      evaluationFrequency: "PT5M",
      windowSize: "PT15M",
      criteria: {
        allOf: [
          {
            query,
            // Sum itemCount, not rows: sampling keeps one row per itemCount
            // events, so counting rows under-reports exactly when load is high.
            timeAggregation: "Total",
            metricMeasureColumn: "itemCount",
            operator: "GreaterThan",
            threshold,
            failingPeriods: { numberOfEvaluationPeriods: 1, minFailingPeriodsToAlert: 1 },
          },
        ],
      },
      actions: { actionGroups: actionGroup ? [actionGroup.id] : [] },
      tags: args.tags,
    });

  return {
    actionGroup,
    alerts: [
      metricAlert(
        "pubsub-connection-quota",
        "Web PubSub connections above 80% of the units' quota: raise agentforeach:webPubSubUnits",
        args.webPubSubId,
        {
          metricNamespace: "Microsoft.SignalRService/WebPubSub",
          metricName: "ConnectionQuotaUtilization",
          timeAggregation: "Maximum",
          operator: "GreaterThan",
          threshold: 80,
        },
      ),
      metricAlert("cosmos-throttling", "Cosmos DB throttled more than 20 requests (429) in 5 minutes", args.cosmosAccountId, {
        metricNamespace: "Microsoft.DocumentDB/databaseAccounts",
        metricName: "TotalRequests",
        timeAggregation: "Count",
        operator: "GreaterThan",
        threshold: 20,
        dimensions: [{ name: "StatusCode", operator: "Include", values: ["429"] }],
      }),
      // Flex Consumption apps don't emit the Http5xx platform metric, and
      // host.json keeps request telemetry to failed invocations only, so
      // count what the app itself reports: exceptions (including worker
      // processes killed mid-run) and error-level log lines.
      logAlert(
        "errors",
        "More than 20 exceptions or error-level log lines in 15 minutes",
        "union exceptions, (traces | where severityLevel >= 3)",
        20,
        1,
      ),
      logAlert(
        "rate-limited",
        "More than 100 messages refused by the rate limit in 15 minutes (abuse, or a client retry storm)",
        'traces | where message has "[ratelimit] refused"',
        100,
        3,
      ),
      logAlert(
        "run-timeouts",
        "More than 5 turns failed on their deadline or a stalled model stream in 15 minutes",
        'traces | where message has "runAgentTurn FAILED" and (message has "timed out" or message has "no events for")',
        5,
      ),
    ],
  };
}
