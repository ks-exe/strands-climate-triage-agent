#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { DataQualityInspectorStack } from "../lib/data-quality-inspector-stack";

const app = new cdk.App();
const region = app.node.tryGetContext("region")?.toString() ?? process.env.AWS_REGION ?? "us-east-2";

new DataQualityInspectorStack(app, "DataQualityInspectorStack", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region
  }
});
