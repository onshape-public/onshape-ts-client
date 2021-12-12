import * as randomstring from 'randomstring';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as unirest from 'unirest';
import { IUniResponse, IUniRest } from 'unirest';
import { mainLog } from './logger';

const LOG = mainLog();

interface StackCredential {
  url: string;
  accessKey: string;
  secretKey: string;
}

export class ApiClient {
  private baseURL: string = null;
  private accessKey: string = null;
  private secretKey: string = null;

  public static async createApiClient(stackToUse?: string): Promise<ApiClient> {
    const credentialsFilePath = './credentials.json';
    if (!fs.existsSync(credentialsFilePath)) {
      throw new Error(`${credentialsFilePath} not found`);
    }

    const fileJson: string = fs.readFileSync(credentialsFilePath, 'utf8') as string;
    const credentials = JSON.parse(fileJson) as { [id: string]: StackCredential; };
    let credsToUse: StackCredential = null;
    for (const [key, value] of Object.entries(credentials)) {
      if (stackToUse) {
        if (key === stackToUse) {
          credsToUse = value;
          break;
        }
      } else {
        stackToUse = key;
        credsToUse = value;
        break;
      }
    }

    if (stackToUse && !credsToUse) {
      throw new Error(`No credentials for "${stackToUse}" in "${credentialsFilePath}"`);
    }

    credsToUse.url = credsToUse.url || 'https://cad.onshape.com/';
    if (!credsToUse.url.match(/^http/)) {
      throw new Error(`url ${credsToUse.url} is invalid`);
    }

    LOG.info(`Creating api client against stack=${stackToUse} url=${credsToUse.url}`);
    if (!credsToUse) {
      throw new Error(`No credentials for stack=${stackToUse} in ${credentialsFilePath}`);
    }

    const apiClient = new ApiClient(credsToUse.url, credsToUse.accessKey, credsToUse.secretKey);
    return apiClient;
  }

  public async post(apiRelativePath: string, bodyData: unknown): Promise<unknown> {
    await this.avoidApiLimit();
    return await this.callApiVerb(apiRelativePath, 'POST', bodyData);
  }

  public async get(apiRelativePath: string): Promise<unknown> {
    await this.avoidApiLimit();
    return await this.callApiVerb(apiRelativePath, 'GET');
  }

  private constructor(baseURL: string, accessKey: string, secretKey: string) {
    if (!baseURL) {
      throw new Error('baseURL cannot be empty');
    }

    if (!accessKey) {
      throw new Error('accessKey cannot be empty');
    }

    if (!secretKey) {
      throw new Error('secretKey cannot be empty');
    }

    this.baseURL = baseURL;
    this.accessKey = accessKey;
    this.secretKey = secretKey;
  }

  private isStatusCodeBad(statusCode: number): boolean {
    return statusCode >= 300 || statusCode <= 100;
  }

  private async callApiVerb(apiRelativePath: string, verb: string, bodyData?: unknown): Promise<unknown> {
    const self = this;
    const fullUri = apiRelativePath.startsWith('http') ? apiRelativePath : new URL(apiRelativePath, this.baseURL).toString();
    LOG.debug(`Calling ${verb} ${fullUri}`);
    return new Promise(function (resolve, reject) {
      const lunitest = self.getSignedUnirest(fullUri, verb);
      if (bodyData) {
        lunitest.type('json')
          .header('Accept', 'application/json')
          .send(bodyData)
          .timeout(600000);
      }

      lunitest.end(function (response: IUniResponse) {
        if (self.isStatusCodeBad(response.statusCode) || response.error) {
          const errorJson = {
            statusCode: response.statusCode || 'UNKNOWN_STATUS_CODE',
            body: response.body || 'NO_BODY',
          };
          LOG.error(`${fullUri} failed`, errorJson);
          reject(errorJson);
        } else {
          resolve(response.body);
        }
      });
    });
  }

  private async avoidApiLimit(): Promise<boolean> {
    return new Promise((resolve) => setTimeout(resolve, 200));
  }

  private getSignedUnirest(fullUri: string, method: string, contentType?: string) {
    const authDate = new Date().toUTCString();
    const onNonce = randomstring.generate({
      length: 25, charset: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz1234567890',
    });

    const parsedUrl = new URL(fullUri);
    const queryString = parsedUrl.searchParams.toString();
    if (queryString) {
      parsedUrl.search = '';
      fullUri = parsedUrl.toString() + '?' + queryString;
    }

    contentType = contentType || 'application/json';

    const hmacString = [
      method,
      onNonce,
      authDate,
      contentType,
      parsedUrl.pathname,
      queryString,
      ''
    ].join('\n').toLowerCase();

    const hmac = crypto.createHmac('sha256', this.secretKey);
    hmac.update(hmacString);
    const signature = hmac.digest('base64');
    const asign = 'On ' + this.accessKey + ':HmacSHA256:' + signature;

    let lunitest: IUniRest = unirest as IUniRest;
    if ('GET' === method) {
      lunitest = lunitest.get(fullUri);
    } else if ('POST' === method) {
      lunitest = lunitest.post(fullUri);
    } else if ('PATCH' === method) {
      lunitest = lunitest.patch(fullUri);
    } else if ('HEAD' === method) {
      lunitest = lunitest.head(fullUri);
    } else if ('PUT' === method) {
      lunitest = lunitest.put(fullUri);
    } else if ('DELETE' === method) {
      lunitest = lunitest.delete(fullUri);
    }
    lunitest.header('Content-Type', contentType);
    lunitest.header('On-Nonce', onNonce);
    lunitest.header('Date', authDate);
    lunitest.header('Authorization', asign);
    lunitest.header('Accept', 'application/vnd.onshape.v1+json,application/json');
    return lunitest;
  }
}


