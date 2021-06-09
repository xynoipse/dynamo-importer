const csv = require('fast-csv');
const pLimit = require('p-limit');
const aws = require('aws-sdk');

aws.config.region = 'us-west-2';

const dynamoClient = new aws.DynamoDB({
  apiVersion: '2012-08-10',
  maxRetries: 0,
}); /* Disable retries, we will handle it manually */
const s3Client = new aws.S3({ apiVersion: '2006-03-01' });

function delay(ms) {
  return new Promise((resolve, reject) => setTimeout(resolve, ms));
}

function DynamoItem(item) {
  return {
    id: { S: item.id },
    name: { S: item.name },
    surname: { S: item.surname },
    phone_number: { S: item.phone_number },
    id_number: { S: item.id_number },
  };
}

async function ImportStreamToDynamo(
  stream,
  tableName,
  concurrentBatchSubmit = 20,
  readAheadBatchSubmit = 40,
  maxRowsProcess = 0
) {
  console.log('Start ImportStreamToDynamo');

  /* A Limit function that limits the amount of DynamoDB Batch Request will be done at any given moment */
  let limit = pLimit(concurrentBatchSubmit);

  let batchItems = [];
  let limitBatchArr = [];

  let count = { second: 0, row: 0, batches: 0, throttles: 0, wcu: 0 };
  let tps = { prev_row: 0, prev_wcu: 0, prev_throttles: 0 };
  let tpsInterval = null;

  let success = true;

  async function DynamoBatchWrite(dynamoItems, retryCount = 0) {
    let params = {
      RequestItems: {},
      ReturnConsumedCapacity: 'TOTAL',
    };
    params.RequestItems[tableName] = dynamoItems.map((item) => {
      return { PutRequest: { Item: item } };
    });

    let retryItems = [];

    return dynamoClient
      .batchWriteItem(params)
      .promise()
      .then(async (resp) => {
        count.wcu += resp.ConsumedCapacity[0].CapacityUnits;

        /* Handle partial failures */
        if (
          resp.UnprocessedItems &&
          resp.UnprocessedItems[this.TableName] &&
          resp.UnprocessedItems[this.TableName].length > 0
        )
          retryItems = resp.UnprocessedItems[this.TableName];
      })
      .catch(async (err) => {
        /* Only if all DynamoDB operations fail, or the API is throttled */
        if (
          err.code == 'ProvisionedThroughputExceededException' ||
          err.code == 'ThrottlingException'
        )
          retryItems = dynamoItems;
        else throw err;
      })
      .then(async () => {
        if (retryItems.length !== 0) {
          count.throttles++;
          retryCount++;

          /* Delay Exponential with jitter before retrying these items */
          let delayTime = retryCount * retryCount * 50;
          let jitter = Math.ceil(Math.random() * 50);

          if (delayTime > 3000) {
            /* Cap wait time and also increase jitter */
            delayTime = 3000;
            jitter = jitter * 3;
          }

          if (retryCount > 15) throw Error('DynamoDB batchWriteItem retries exhausted');

          console.log(
            'Retry: ' + retryCount + ' ::: Retrying in: ' + (delayTime + jitter),
            retryItems[0].id
          );
          await delay(delayTime + jitter);
          await DynamoBatchWrite(retryItems, retryCount);
        }
      });
  }

  return await new Promise(async function (resolve, reject) {
    let parser = csv
      .parseStream(stream, {
        headers: true,
        strictColumnHandling: false,
        discardUnmappedColumns: true,
      })
      .on('data', async function (line) {
        try {
          count.row++;
          batchItems.push(DynamoItem(line));

          /* If have 25 items, save the DynamoDB Batch request to be executed later */
          if (batchItems.length === 25) {
            /* Strange function just captures data value of array atm and passes to function */
            (function (batch) {
              limitBatchArr.push(
                limit(() => {
                  return DynamoBatchWrite(batch);
                })
              );
            })(batchItems);

            batchItems = []; /* Clear array of temp batch items now*/
          }

          /* If have X (readAheadBatchSubmit) amount of DynamoDB Batch requests waiting to be executed
           * Pause the reading of new items
           * Execute them Y (concurrentBatchSubmit) amount in parallel
           * Resume reading new items
           */
          if (limitBatchArr.length >= readAheadBatchSubmit) {
            /* Print some useful information, once per second */
            if (tpsInterval === null) {
              tpsInterval = setInterval(async () => {
                console.log(
                  'Info -> ' +
                    JSON.stringify({
                      Total: {
                        Seconds: count.second++,
                        RowsProcessed: count.row,
                        Throttles: count.throttles,
                      },
                      Throughput: {
                        RowsProcessed: count.row - tps.prev_row,
                        WCU_Consumed: count.wcu - tps.prev_wcu,
                        Throttles: count.throttles - tps.prev_throttles,
                      },
                    })
                      .replace(/:/g, ': ')
                      .replace(/,/g, ', ')
                      .replace(/"/g, '')
                );

                tps.prev_row = count.row;
                tps.prev_wcu = count.wcu;
                tps.prev_throttles = count.throttles;
              }, 1000);
            }

            if (maxRowsProcess && count.row > maxRowsProcess)
              throw new Error('Max Rows Processed');

            parser.pause();
            await Promise.all(limitBatchArr);
            parser.resume();

            limitBatchArr = [];
          }
        } catch (e) {
          reject(e);
          success = false;
        }
      })
      .on('end', async function () {
        /* If throughput counter running */
        if (tpsInterval !== null) clearInterval(tpsInterval);
        if (!success) return;

        try {
          if (maxRowsProcess && count.row > maxRowsProcess)
            throw new Error('Max Rows Processed');

          /* If have full batches that are not submitted yet (checking 0 because we clear all of them after all of them are send) */
          if (limitBatchArr.length !== 0) await Promise.all(limitBatchArr);

          /* Left overs, if the last batch is not a full batch (checking 0 because clears it after a full batch is created) */
          if (batchItems.length !== 0) await DynamoBatchWrite(batchItems);

          resolve(true);
        } catch (e) {
          reject(e);
        }
      })
      .on('error', function (err) {
        reject(err);
      });
  });
}

async function DeleteS3Object(Bucket, Key) {
  const deleteObjectParams = { Bucket, Key };

  try {
    s3Client.deleteObject(deleteObjectParams).promise();
  } catch (err) {
    throw err;
  }
}

async function S3ToDynamo(
  Bucket,
  Key,
  tableName,
  deleteS3File,
  concurrentBatchSubmit,
  readAheadBatchSubmit,
  maxRowsProcess
) {
  console.log('Start S3ToDynamo');

  let s3DataReadStream = s3Client.getObject({ Bucket, Key }).createReadStream();
  s3DataReadStream.on('error', (streamErr) => {
    throw new Error(streamErr);
  });

  const res = await ImportStreamToDynamo(
    s3DataReadStream,
    tableName,
    concurrentBatchSubmit,
    readAheadBatchSubmit,
    maxRowsProcess
  );

  if (deleteS3File) DeleteS3Object(Bucket, Key);

  return res;
}

module.exports.handler = async (event, context) => {
  const { eventSource, awsRegion, s3 } = event.Records[0];
  console.log('AWS Region', awsRegion);

  if (eventSource === 'aws:s3') {
    const { bucket, object } = s3;

    return await S3ToDynamo(
      bucket.name,
      object.key,
      process.env.DYNAMO_TABLE_NAME,
      JSON.parse(process.env.DELETE_S3_FILE.toLowerCase()),
      parseInt(process.env.CONCURRENT_BATCH_SUBMITS),
      parseInt(process.env.READ_AHEAD_BATCHES),
      parseInt(process.env.MAX_ROWS_SUBMIT)
    );
  }
};
