import { UniversalLogger } from "@gallofeliz/logger";
import { InfluxDB } from "influx";
import { snakeCase, mapKeys } from "lodash";
import { flatten } from 'flat'

type MetricValues = Record<string, number | Record<string, number | Record<string, number | Record<string, number>>>>
type MetricTags = Record<string, string | Record<string, string | Record<string, string | Record<string, string>>>>

export interface Metric {
    name: string
    date: Date
    tags?: MetricTags
    values: MetricValues
}

export interface OutputHandler {
    handle(metrics: Metric|Metric[]): Promise<void>
}

export class LoggerOutputHandler implements OutputHandler {
    protected logger: UniversalLogger

    public constructor(logger: UniversalLogger) {
        this.logger = logger
    }

    async handle(metrics: Metric|Metric[]) {
        (Array.isArray(metrics) ? metrics : [metrics] ).forEach(metric => {
            this.logger.info('Metric', {metric})
        })
    }
}

export class InfluxDBOutputHandler implements OutputHandler {
    protected db?: InfluxDB
    protected dbName: string
    protected duration?: number

    public constructor({dbName, duration}: {dbName: string, duration?: number}) {
        this.dbName = dbName
        this.duration = duration
    }

    protected async getDb() {
        if (!this.db) {
            this.db = new InfluxDB({
                database: this.dbName
            })
            await this.db.createDatabase(this.dbName)

            if (this.duration) {
                await this.db.createRetentionPolicy('metricCollector', {
                    database: this.dbName,
                    duration: this.duration.toString() + 'ms',
                    replication: 1
                })
            }
        }

        return this.db
    }

    async handle(metrics: Metric|Metric[]) {
        const influxPoints: any = (Array.isArray(metrics) ? metrics : [metrics] ).map(metric => ({
            measurement: snakeCase(metric.name),
            tags: mapKeys(flatten(metric.tags || {}), (_, k) => snakeCase(k as any)),
            fields: mapKeys(flatten(metric.values), (_, k) => snakeCase(k as any)),
            timestamp: metric.date,
        }))

        await (await this.getDb()).writePoints(influxPoints, {
            retentionPolicy: this.duration ? 'metricCollector' : undefined
        })
    }
}
