/** The evaluation foundation's resource graph, with Pulumi's mocks (nothing is created). */

import test from "node:test";
import assert from "node:assert/strict";
import * as pulumi from "@pulumi/pulumi";
import { APPLICATION_DATABASE_USER, createFoundation } from "./stack.js";

const ACCOUNT = "123456789012";
const resources: { type: string; name: string; inputs: any }[] = [];

pulumi.runtime.setMocks(
  {
    newResource(args) {
      resources.push({ type: args.type, name: args.name, inputs: args.inputs });
      const state: any = { ...args.inputs, arn: `arn:aws:test:us-west-2:${ACCOUNT}:${args.name}` };
      if (args.type === "random:index/randomPassword:RandomPassword") state.result = "a".repeat(40);
      if (args.type === "aws:rds/instance:Instance") {
        state.address = "test.rds.amazonaws.com";
        state.masterUserSecrets = [{ secretArn: `arn:aws:secretsmanager:us-west-2:${ACCOUNT}:secret:rds-master` }];
      }
      return { id: `${args.name}_id`, state };
    },
    call(args) {
      if (args.token.includes("getCallerIdentity")) return { accountId: ACCOUNT };
      if (args.token.includes("getAvailabilityZones")) return { names: ["us-west-2a", "us-west-2b"] };
      if (args.token.includes("getRegion")) return { region: "us-west-2" };
      return args.inputs;
    },
  },
  "agentforeach-aws-foundation",
  "test",
  false,
);

test("the foundation: a private, TLS-only database, an owner role kept apart, and admin-only test users", async () => {
  let outputs: Record<string, unknown> = {};
  await pulumi.runtime.runInPulumiStack(async () => {
    const f = createFoundation({ prefix: "afe-eval", engineVersion: "17.11", instanceClass: "db.t4g.small" });
    outputs = await new Promise((resolve) =>
      pulumi
        .all([f.databaseSecretArn, f.migrationSecretArn, f.jwtJwksUri, f.privateSubnetIds])
        .apply(([database, migration, jwks, subnets]) => resolve({ database, migration, jwks, subnets })),
    );
  });
  const one = (name: string) => {
    const found = resources.find((r) => r.name === name);
    assert.ok(found, `${name} exists`);
    return found.inputs;
  };

  const db = one("eval-database");
  assert.equal(db.publiclyAccessible, false);
  assert.equal(db.storageEncrypted, true);
  assert.equal(db.manageMasterUserPassword, true, "RDS keeps the owner's password; it never passes through Pulumi");
  assert.equal(db.deletionProtection, true);
  assert.equal(db.skipFinalSnapshot, false);
  assert.deepEqual(one("eval-database-network").ingress, [], "no inbound rule until the application stack adds its own");
  assert.deepEqual(one("eval-database-parameters").parameters[0], { name: "rds.force_ssl", value: "1", applyMethod: "pending-reboot" });

  const raw = one("eval-database-secret-value").secretString;
  const secret = JSON.parse(typeof raw === "string" ? raw : raw.value);
  assert.equal(secret.username, APPLICATION_DATABASE_USER);
  assert.match(secret.DATABASE_URL, /^postgresql:\/\/afe_app:a{40}@test\.rds\.amazonaws\.com:5432\/agentforeach\?sslmode=verify-full/);
  assert.equal(outputs.migration, `arn:aws:secretsmanager:us-west-2:${ACCOUNT}:secret:rds-master`, "the owner role's secret is an output of its own");
  assert.notEqual(outputs.migration, outputs.database);
  assert.equal((outputs.subnets as string[]).length, 2);
  for (const subnet of resources.filter((r) => r.type === "aws:ec2/subnet:Subnet")) {
    assert.equal(subnet.inputs.mapPublicIpOnLaunch, false, `${subnet.name}: no public addresses`);
  }

  assert.equal(one("eval-users").adminCreateUserConfig.allowAdminCreateUserOnly, true);
  assert.equal(one("eval-client").generateSecret, false);
  assert.deepEqual(one("eval-client").explicitAuthFlows, ["ALLOW_ADMIN_USER_PASSWORD_AUTH"]);
  assert.equal(outputs.jwks, "https://cognito-idp.us-west-2.amazonaws.com/eval-users_id/.well-known/jwks.json");

  // S3 without the NAT: ECR's layers, and otherwise this account's principals on this account's buckets.
  const s3 = JSON.parse(one("eval-s3").policy).Statement;
  assert.deepEqual(s3[0], { Effect: "Allow", Principal: "*", Action: "s3:GetObject", Resource: "arn:aws:s3:::prod-us-west-2-starport-layer-bucket/*" });
  assert.deepEqual(s3[1].Condition.StringEquals, { "aws:PrincipalAccount": ACCOUNT, "s3:ResourceAccount": ACCOUNT });
  assert.ok(!resources.some((r) => r.type === "aws:lambda/function:Function"), "migrations run in the application stack");
});

test("foundation settings are checked first", () => {
  assert.throws(() => createFoundation({ prefix: "X", engineVersion: "17", instanceClass: "db.t4g.small" }), /prefix/);
  assert.throws(() => createFoundation({ prefix: "afe-eval", engineVersion: "latest", instanceClass: "db.t4g.small" }), /engineVersion/);
});
