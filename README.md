# Data Quality Inspector

Modern full-stack CSV data quality dashboard deployed on AWS.

## What It Does

- Upload a CSV file from the browser
- Calculates row and column counts
- Finds missing values per column
- Counts duplicate rows
- Detects column data types
- Computes a 0 to 100 data quality score
- Generates a concise AI summary with Amazon Bedrock

## AWS Services Used

- **Amazon S3** stores the built React dashboard as static website files.
- **Amazon API Gateway HTTP API** provides the public HTTPS URL and routes `/api/*` requests to the API.
- **AWS Lambda** parses the CSV and computes the quality profile without managing servers.
- **Amazon Bedrock** generates the data quality summary from derived metrics.
- **Amazon CloudWatch Logs** captures Lambda logs for debugging.
- **AWS IAM** grants the Lambda permission to invoke Bedrock.
- **AWS CDK** defines and deploys the infrastructure.

CloudFront is the preferred CDN layer for a production frontend, but this stack uses API Gateway in front of S3 so it can deploy in projects that are not yet verified for new CloudFront resources.

## Local Development

```bash
npm install
npm run dev
```

For local API testing after deployment:

```bash
$env:VITE_API_URL="https://YOUR_API_ID.execute-api.us-east-2.amazonaws.com"
npm run dev
```

## Deploy

The stack targets `us-east-2` by default, matching United States projects in the new AWS experience.
The deployed Lambda uses Bedrock Runtime in `us-east-1` by default because the tested `us-east-2` Bedrock runtime endpoint returned `Operation not allowed` for model invocation, while `us-east-1` allowed Nova Micro on-demand invocation.

```bash
npm install
npx cdk bootstrap aws://ACCOUNT_ID/us-east-2
npm run deploy
```

You can override the Bedrock model:

```bash
npm run deploy -- --context bedrockModelId=amazon.nova-micro-v1:0
```

You can also override the Bedrock runtime Region:

```bash
npm run deploy -- --context bedrockRegion=us-east-1
```

The deployed application URL is printed as the `ApplicationUrl` stack output.
