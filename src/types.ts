import { ModalMessageModalSubmitInteraction } from "discord.js";

export type BossStatus = 'alive' | 'dead' | 'unknown' | 'defeated';

export type TBoss = {
    name: string;
    id: string;
}

export type TResponseInfo = {
    interaction: ModalMessageModalSubmitInteraction,
    bossId: string
}

export type BossLayerStatus = {
    layer: string;
    status: BossStatus;
    lastScouted?: Date;
    nextRespawn?: Date;
};

type TLayerId = string;

export interface IDatabase {
    // guilds
    allGuilds(): Promise<IGuild[]>;
    guildById(id: string): Promise<IGuild | undefined>;
    updateGuild(id: string, guild: IGuild): Promise<void>;
    
    updateBossReport(guildId: string, report: IBossReport): Promise<void>
    latestBossReport(guildId: string): Promise<IBossReport | null>
    totalKillsForGuild(): Promise<Record<string, number>>

    // scouting
    latestReportsForBoss(bossId: string, guildId: string): Promise<Record<TLayerId, IScoutReport | undefined>>;
    insertScoutReport(report: IScoutReport): Promise<void>;    
}

export type BossData = {
    name: string;
    id: string;
    layers: BossLayerStatus[];
    totalKills: number;
    messageId?: string;
    selectedLayer?: string;
};

export type TBossId = "kazzy" | "azzy";

export type IBossReport = Record<TBossId, BossData>;

export interface IGuild {
    guildId: string,

    worldBossFoundMessage: string,
    worldBossRespawnMessage: string,
    worldBossNotificationChannel: string,
    layerRespawnNotifications: boolean,
}

export interface IScoutReport {
    timestamp: Date, 
    guildId: string,
    bossId: string,
    layerId: string,
    state: BossStatus, // state the boss was in 
    reporterId: string, // user who reported the boss
}

