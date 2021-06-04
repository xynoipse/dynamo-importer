# dynamo-importer

## What's in side the box

A Node.js Lambda function streams a S3 File and then imports it into DynamoDB using the BatchWrite API.

### Environment variables passed to the function:

- CONCURRENT_BATCH_SUBMITS: Make reference to the article, this is the amount of concurrent batch api writes made to the DynamoDB table
- READ_AHEAD_BATCHES: Make reference to the article, this is the amount of batches that will be read from the stream before they will be sent to DynamoDB at the CONCURRENT_BATCH_SUBMITS rate. This value must be greater or equal to CONCURRENT_BATCH_SUBMITS.
- MAX_ROWS_SUBMIT: Used for testing, setting to 0 means import everything, else stop the import when this amount of rows has been imported.
- AWS_NODEJS_CONNECTION_REUSE_ENABLED: AWS SDK NodeJS variable that allows the SDK to reuse TCP connections for faster API calls

Example:

```
CONCURRENT_BATCH_SUBMITS: 20
READ_AHEAD_BATCHES: 40
MAX_ROWS_SUBMIT: 10000
AWS_NODEJS_CONNECTION_REUSE_ENABLED: 1
```

### Lambda Function Event Object:

- DYNAMO_TABLE_NAME: DynamoDB table name where we will import into
- S3_BUCKET_NAME: Name of the bucket where the CSV is stored
- S3_FILE_NAME: Name of the CSV file in the bucket
- MAX_ROWS_SUBMIT: Used for testing, setting to 0 means import everything, else stop the import when this amount of rows has been imported. if not specified in the object, default will be 100 rows. (note: it will throw an error when max rows reached)

Example:

```
{
  "FROM": "s3",
  "DYNAMO_TABLE_NAME": "TableName",
  "S3_BUCKET_NAME": "aws.s3.bucket.name",
  "S3_FILE_NAME": "path/to/file.csv",
  "MAX_ROWS_SUBMIT": 10000
}
```

### Requirements

- AWS CLI v2 - https://docs.aws.amazon.com/cli/latest/userguide/install-cliv2.html
- AWS SAM CLI - https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/serverless-sam-cli-install.html
- Docker - https://docs.docker.com/get-docker/ (SAM CLI Requires Docker)

### Install

1. Setup and configure your aws profile by running `aws configure --profile <PROFILE NAME>`

2. In the /package.json file, change the profile name set on the scripts in line 8, 9, and 10 `--profile <PROFILE NAME>`

3. In the /package.json file, use your bucket for SAM deployments so change the content in line 9 (\_sam_package): `--s3-bucket <YOUR EXISTING MANUAL CREATED S3 BUCKET NAME>`

4. Run the `npm run deploy` npm command to let SAM build, package and deploy your CloudFormation

### Batteries included

#### Data generation tool

Using `mocker-data-generator` which abstracts over `faker` CSV files are generated.

A large CSV file containing 1,000,000 records that will be roughly around 80MB+. Upload this file to your bucket before running the S3 test or the Lambda in the cloud.

1. Install the required dependencies by running `npm install`

2. Run `npm run generate-data`

### Checking deployment on AWS

- After deploying, check your [**CloudFormation**](https://us-west-2.console.aws.amazon.com/cloudformation/home?region=us-west-2#/stacks) for stack created and named `dynamo-importer`
- You can go to the [**AWS Lambda > Functions**](https://us-west-2.console.aws.amazon.com/lambda/home?region=us-west-2#/functions), you should see lambda function named `dynamo-importer-worker`

### Invoking a Lambda function

- Open your lambda function from the **AWS Lambda > Functions** and below after Function overview, go to tab Test
- Add your proper `Lambda Function Event Object` to run the lamdba function, more info about this lamdba function accepted event object [here](#lambda-function-event-object)
- Recommended to name and save the event in Test event
