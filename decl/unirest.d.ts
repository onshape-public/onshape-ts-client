/* eslint-disable @typescript-eslint/no-explicit-any */

declare module 'unirest' {
  export interface IUniResponse {
    statusCode: number;
    error: string;
    body: string;
  }
  export interface IUniRest {
    get(...args: any[]): IUniRest;
    post(...args: any[]): IUniRest;
    patch(...args: any[]): IUniRest;
    head(...args: any[]): IUniRest;
    put(...args: any[]): IUniRest;
    delete(...args: any[]): IUniRest;
    header(...args: any[]): IUniRest;
    type(...args: any[]): IUniRest;
    timeout(...args: any[]): IUniRest;
    send(...args: any[]): IUniRest;
    end(...args: any[]): IUniRest;
  }
}
