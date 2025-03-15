import { Collection, Db, Document, MongoClient, ObjectId } from "mongodb";
import { IDatabase, IGuild, IScoutReport, BossData, IBossReport } from "./types"; // Adjust path as needed

export class Database implements IDatabase {
    constructor(
        private guilds: Collection<IGuild>,
        private bosses: Collection<IBossReport>,
        private reports: Collection<IScoutReport> // Collection for scout reports
    ) {}

    async allGuilds(): Promise<IGuild[]> {
        const res: IGuild[] = [];
        for await (const doc of this.guilds.find()) {
            res.push(doc);
        }
        return res;
    }

    async totalKillsForGuild(): Promise<Record<string, number>> {
        const pipeline = [
            {
                $group: {
                    _id: "$guildId",
                    totalKills: { $sum: "$totalKills" }
                }
            }
        ];

        const results = await this.bosses.aggregate(pipeline).toArray();

        return results.reduce((acc, result) => {
            acc[result._id] = result.totalKills;
            return acc;
        }, {} as Record<string, number>);
    }

    async guildById(id: string): Promise<IGuild | undefined> {
        const guild = await this.guilds.findOne({ guildId: id });
        return guild ? (guild as unknown as IGuild) : undefined;
    }

    async updateGuild(id: string, guild: IGuild): Promise<void> {
        await this.guilds.updateOne(
            { guildId: id },
            { $set: guild },
            { upsert: true } // Creates the guild if it doesn't exist
        );
    }

    async updateBossReport(guildId: string, report: IBossReport): Promise<void> {
        await this.bosses.updateOne({guildId}, { $set: {guildId, ...report}}, {upsert: true});
    }

    async latestBossReport(guildId: string): Promise<IBossReport | null> {
        return await this.bosses.findOne({guildId});
    }

    async latestReportsForBoss(bossId: string, guildId: string): Promise<Record<string, IScoutReport | undefined>> {
        const reports = await this.reports
            .find({ bossId, guildId })
            .sort({ timestamp: -1 }) // Get the latest reports first
            .limit(1)
            .toArray();

        return reports.reduce((acc, report) => {
            acc[report.layerId] = report as unknown as IScoutReport;
            return acc;
        }, {} as Record<string, IScoutReport | undefined>);
    }

    async insertScoutReport(report: IScoutReport): Promise<void> {
        await this.reports.insertOne({
            ...report,
            timestamp: new Date(report.timestamp) // Ensure timestamp is stored correctly
        });
    }

    static async connect(): Promise<IDatabase> {
        const client: MongoClient = new MongoClient(process.env.DB_CONN_STRING!);
        await client.connect();

        const db: Db = client.db(process.env.DB_NAME);

        const guilds: Collection<IGuild> = db.collection(process.env.GUILDS_COLLECTION_NAME!);
        const bosses: Collection<IBossReport> = db.collection(process.env.BOSSES_COLLECTION_NAME!);
        const reports: Collection<IScoutReport> = db.collection(process.env.REPORTS_COLLECTION_NAME!);

        return new Database(guilds, bosses, reports);
    }
}
