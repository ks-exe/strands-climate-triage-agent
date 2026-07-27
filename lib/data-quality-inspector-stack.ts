import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as cdk from "aws-cdk-lib";
import { Duration, RemovalPolicy, Stack, StackProps } from "aws-cdk-lib";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as integrations from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as nodejs from "aws-cdk-lib/aws-lambda-nodejs";
import * as logs from "aws-cdk-lib/aws-logs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3deploy from "aws-cdk-lib/aws-s3-deployment";
import { Construct } from "constructs";

export class DataQualityInspectorStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);
    const stackDir = path.dirname(fileURLToPath(import.meta.url));

    const bedrockModelId =
      this.node.tryGetContext("bedrockModelId")?.toString() ?? "amazon.nova-micro-v1:0";
    const bedrockRegion = this.node.tryGetContext("bedrockRegion")?.toString() ?? "us-east-1";

    const inspectorFunction = new nodejs.NodejsFunction(this, "InspectorFunction", {
      entry: path.join(stackDir, "..", "lambda", "inspect.ts"),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      timeout: Duration.seconds(25),
      memorySize: 512,
      logRetention: logs.RetentionDays.ONE_WEEK,
      environment: {
        BEDROCK_REGION: bedrockRegion,
        BEDROCK_MODEL_ID: bedrockModelId
      },
      bundling: {
        minify: true,
        sourceMap: true,
        target: "node22",
        externalModules: []
      }
    });

    inspectorFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["bedrock:InvokeModel"],
        resources: [
          Stack.of(this).formatArn({
            service: "bedrock",
            region: bedrockRegion,
            account: "",
            resource: "foundation-model",
            resourceName: "*"
          })
        ]
      })
    );

    const httpApi = new apigwv2.HttpApi(this, "InspectorApi", {
      corsPreflight: {
        allowHeaders: ["content-type"],
        allowMethods: [apigwv2.CorsHttpMethod.OPTIONS, apigwv2.CorsHttpMethod.POST],
        allowOrigins: ["*"],
        maxAge: Duration.days(1)
      }
    });

    httpApi.addRoutes({
      path: "/api/inspect",
      methods: [apigwv2.HttpMethod.POST],
      integration: new integrations.HttpLambdaIntegration("InspectIntegration", inspectorFunction)
    });

    const siteBucket = new s3.Bucket(this, "SiteBucket", {
      websiteIndexDocument: "index.html",
      websiteErrorDocument: "index.html",
      publicReadAccess: true,
      blockPublicAccess: new s3.BlockPublicAccess({
        blockPublicAcls: false,
        blockPublicPolicy: false,
        ignorePublicAcls: false,
        restrictPublicBuckets: false
      }),
      encryption: s3.BucketEncryption.S3_MANAGED,
      autoDeleteObjects: true,
      removalPolicy: RemovalPolicy.DESTROY
    });

    const websiteRootIntegration = new integrations.HttpUrlIntegration(
      "WebsiteRootIntegration",
      siteBucket.bucketWebsiteUrl
    );

    const websiteProxyIntegration = new integrations.HttpUrlIntegration(
      "WebsiteProxyIntegration",
      `${siteBucket.bucketWebsiteUrl}/{proxy}`
    );

    httpApi.addRoutes({
      path: "/",
      methods: [apigwv2.HttpMethod.GET],
      integration: websiteRootIntegration
    });

    httpApi.addRoutes({
      path: "/{proxy+}",
      methods: [apigwv2.HttpMethod.GET],
      integration: websiteProxyIntegration
    });

    new s3deploy.BucketDeployment(this, "DeployWebsite", {
      sources: [s3deploy.Source.asset(path.join(stackDir, "..", "dist"))],
      destinationBucket: siteBucket
    });

    new cdk.CfnOutput(this, "ApplicationUrl", {
      value: httpApi.apiEndpoint
    });

    new cdk.CfnOutput(this, "ApiEndpoint", {
      value: httpApi.apiEndpoint
    });

    new cdk.CfnOutput(this, "StaticWebsiteUrl", {
      value: siteBucket.bucketWebsiteUrl
    });

    new cdk.CfnOutput(this, "BedrockModel", {
      value: bedrockModelId
    });

    new cdk.CfnOutput(this, "BedrockRegion", {
      value: bedrockRegion
    });
  }
}
