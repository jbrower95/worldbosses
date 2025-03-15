import { Logger, ILogObj } from "tslog";

export const log: Logger<ILogObj> = new Logger({type: process.env.PRODUCTION == '1' ? 'json' : 'pretty'});