import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";
import { BossData, TBoss } from "./types";

export const BOSSES = [
    {name: 'Azuregos', id: 'azzy'}, 
    {name: 'Lord Kazzak', id: 'kazzy'}
];
export const LAYERS = Array.from({ length: 9 }, (_, i) => `Layer ${i + 1}`);

export const emptyBossData = () => {
    return BOSSES.reduce((acc, boss) => {
        const {name, id} = boss;
        acc[id] = {
            name,
            id,
            layers: LAYERS.map(layer => ({ layer, status: 'unknown' })),
            totalKills: 0,
            selectedLayer: LAYERS[0]
        };
        return acc;
    }, {} as Record<string, BossData>);
}

export function formatBossStatus(boss: BossData) {
    return [
        `# ${boss.name} Scouting Report`,
        ...boss.layers.map(l => {
            if (l.status === 'alive') {
                return `- **${l.layer}:** 👿 **Alive**`;
            } else if (l.status === 'dead') {
                return `- ~~**${l.layer}:**~~ 💀 - respawn: ${l.nextRespawn ? `**${`<t:${Math.floor(l.nextRespawn.getTime()/1000)}>`}**` : '*unknown*'}`;
            } else if (l.status === 'defeated') {
                return `- ~~**${l.layer}:**~~ 💀 - respawn: ${l.nextRespawn ? `**${`<t:${Math.floor(l.nextRespawn.getTime()/1000)}>`}**` : '*unknown*'}`;
            } else {
                return `- **${l.layer}:** ${l.lastScouted ? `*👀: ${`${`<t:${Math.floor(l.lastScouted.getTime()/1000)}>`}`}*` : '*unknown*'}`;
            }
        })
    ].join('\n')
}

export function createActionRow(boss: TBoss) {
    return [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
                .setCustomId(`status_unknown_${boss.id}`)
                .setLabel('?')
                .setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId(`status_dead_${boss.id}`)
                .setLabel('Dead')
                .setStyle(ButtonStyle.Danger),
            new ButtonBuilder()
                .setCustomId(`status_alive_${boss.id}`)
                .setLabel('Alive')
                .setStyle(ButtonStyle.Success),
            new ButtonBuilder()
                .setCustomId(`status_defeated_${boss.id}`)
                .setLabel('Defeated')
                .setStyle(ButtonStyle.Danger)
        )
    ];
}

// kazzak respawns after 72 hours, unless there is a server reset. There is a server reset every Tuesday @ 10am EST.
export function getNextRespawnTime(lastKillTime: Date): Date {
    const respawnTime = new Date(lastKillTime.getTime() + 72 * 60 * 60 * 1000); // 72 hours later
    
    // Find the next Tuesday at 10 AM EST (15:00 UTC)
    const nextReset = new Date(lastKillTime);
    nextReset.setUTCDate(nextReset.getUTCDate() + ((9 - nextReset.getUTCDay()) % 7)); // Move to next Tuesday
    nextReset.setUTCHours(15, 0, 0, 0); // Set to 10 AM EST (15:00 UTC)

    return respawnTime < nextReset ? respawnTime : nextReset;
}