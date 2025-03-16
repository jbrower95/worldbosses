import { Client, GatewayIntentBits, REST, Routes, TextChannel, ActionRowBuilder, ButtonInteraction, ModalBuilder, TextInputBuilder, TextInputStyle, ModalMessageModalSubmitInteraction, ChatInputCommandInteraction, SlashCommandBuilder, Guild, MessageFlags } from 'discord.js';
import { BossStatus, IBossReport, IDatabase, IGuild, TBossId, TResponseInfo } from './types';
import { createActionRow, formatBossStatus, getNextRespawnTime, BOSSES, emptyBossData} from './utils';
import { log } from './log';

const TOKEN = process.env.DISCORD_BOT_TOKEN || '';
const CLIENT_ID = process.env.DISCORD_CLIENT_ID || '';

const DEFAULT_BOSS_MESSAGE = `@everyone %BOSS% is up on layer %LAYER%!`;
const DEFAULT_RESPAWN_MESSAGE = `%BOSS% will respawn soon on layer %LAYER%.`

type TCommandType = 'scouting-notifications-toggle' | 'scouting-message' | 'scouting-channel'

const ONE_HOUR = 1000 * 60 * 60;

const commands = [
    {
        name: 'scouting-notifications-toggle',
        description: 'Enable or disable notifications for scouting.',
    },
    {
        name: 'scouting-message',
        description: 'Set the message sent when a world boss is found.',
    },
    {
        name: 'scouting-channel',
        description: 'Make the current channel the scouting channel',
    }
] as {name: TCommandType, description: string}[];

type TGuildId = string;

export class Bot {
    bossData: Record<TGuildId, IBossReport>;
    client: Client<boolean>
    guilds: IGuild[]

    longUpdatesInterval: NodeJS.Timeout | undefined;

    constructor(private db: IDatabase) {
        this.bossData = {};
    }
    
    async registerCommands() {
        const rest = new REST({ version: '10' }).setToken(TOKEN);
        for (const guild of this.guilds) {
            try {
                await rest.put(Routes.applicationGuildCommands(CLIENT_ID, guild.guildId), { body: commands });
            } catch (e) {
                log.error("failed to register commands for guild", {guild: guild.guildId});
            }
        }
        log.info('/slash commands registered');
    }
    
    async findOrPostScoutingMessages() {
        for (const guild of this.guilds) {
            try {
                await this.initializeGuild(guild.guildId, guild.worldBossNotificationChannel);
            } catch (e) {
                log.error("failed to initialize guild", {guild: guild.guildId, error: e});
            }
        }
    }

    async startLongUpdates() {
        this.longUpdatesInterval = setInterval(async () => {
            // check periodically if any of the bosses statuses are respawned.
            for (let guild of Object.keys(this.bossData)) {
                const guildInfo = this.guilds.find(g => g.guildId === guild);
                if (!guildInfo) {
                    continue;
                }
                const bossReport = this.bossData[guild];
                let didUpdate = false;
                for (let bossId of Object.keys(bossReport)) {
                    const boss = bossReport[bossId as TBossId];
                    for (let layer of boss.layers) {
                        if ((layer.status === 'dead' || layer.status === 'defeated') && layer.nextRespawn && (layer.nextRespawn.getTime() < new Date().getTime())) {
                            // boss respawned.
                            layer.status = "unknown";
                            layer.nextRespawn = undefined;
                            didUpdate = true;
                            log.info("boss respawning", {boss: boss.id, guild: guildInfo.guildId, layer: layer.layer});

                            if (guildInfo?.worldBossNotificationChannel) {
                                const channel = await this.client.channels.fetch(guildInfo?.worldBossNotificationChannel);
                                if (channel?.isSendable()) {
                                    await channel.send({content: (guildInfo.worldBossRespawnMessage ?? '').replace("%BOSS%", boss.name).replace("%LAYER%", layer.layer)})
                                }
                            }
                        } 
                    }
                }

                if (didUpdate) {
                    await this.db.updateBossReport(guildInfo.guildId, bossReport);
                }
            }
        }, ONE_HOUR);
    }

    async initializeGuild(guildId: string, scoutingChannel: string) {
        const channel = await this.client.channels.fetch(scoutingChannel) as TextChannel;
        if (!channel) {
            log.info(`Couldn't find #scouting channel.`);
            return;
        }

        const bossData = this.bossData[guildId] ?? emptyBossData();
        this.bossData[guildId] = bossData;
    
        const messages = await channel.messages.fetch({ limit: 50 });
        for (const boss of BOSSES) {
            const existingMessage = messages.find(msg => msg.content.includes(boss.name));
            if (existingMessage) {
                log.info(`found existing post for ${boss.name}`, {guildId: channel.guild.id, guild: channel.guild.name})
                bossData[boss.id].messageId = existingMessage.id;
                await existingMessage.pin();
            } else {
                log.info(`creating post for ${boss.name}`, {guildId: channel.guild.id, guild: channel.guild.name})
                const message = await channel.send({ content: formatBossStatus(this.bossData[guildId][boss.id]), components: createActionRow(boss) });
                bossData[boss.id].messageId = message.id;
                await message.pin();
            }
        }
    }

    async updateScoutingMessages(guildId: string, scoutingChannel: string, response?: TResponseInfo) {
        const channel = await this.client.channels.fetch(scoutingChannel) as TextChannel;
        if (!channel) return;

        const bossData = this.bossData[guildId] ?? emptyBossData();
        this.bossData[guildId] = bossData;
    
        if (response !== undefined) {
            // update specific post
            const bossInfo = bossData[response.bossId];
            await response.interaction.update({content: formatBossStatus(bossInfo), components: createActionRow(bossInfo)})
            return;
        } else {
            // update all
            for (const boss of BOSSES) {
                const bossInfo = bossData[boss.id];
                if (bossInfo.messageId) {
                    try {
                        const message = await channel.messages.fetch(bossInfo.messageId);
                        await message.edit({ content: formatBossStatus(bossInfo), components: createActionRow(bossInfo) });
                        await message.pin();
                    } catch (error) {
                        log.error(`Failed to update scouting message for ${boss}:`, error);
                    }
                }
            }
        }
    }

    async handleCommand(cmdInteraction: ChatInputCommandInteraction<any>) {
        if (cmdInteraction.user.id !== cmdInteraction.guild.ownerId) {
            await cmdInteraction.reply({content: "This action is only available to the server's owner.", flags: MessageFlags.Ephemeral});
            return;
        }

        switch (cmdInteraction.commandName as TCommandType) {
            case 'scouting-notifications-toggle':
                const guild = this.guilds.find(g => g.guildId === cmdInteraction.guildId);
                if (!guild) {
                    return await cmdInteraction.reply("experienced an error");
                }
                guild.layerRespawnNotifications = !guild.layerRespawnNotifications;
                await this.db.updateGuild(guild.guildId, guild);
                await cmdInteraction.reply(`toggled notifications ${guild.layerRespawnNotifications ? 'on' : 'off'}!`);
            break;
            case 'scouting-message':
                // TODO: update scouting message.
                // TODO: update in-memory state.
                await cmdInteraction.reply(`updated message to ${cmdInteraction.command}!`);
            break;
            case 'scouting-channel': {
                const guild = this.guilds.find(g => g.guildId === cmdInteraction.guildId);
                if (!guild) {
                    return await cmdInteraction.reply({content: "experienced an error", flags: MessageFlags.Ephemeral});
                }
                if (guild.worldBossNotificationChannel === cmdInteraction.channelId) {
                    return await cmdInteraction.reply({content: `#${cmdInteraction.channel?.name} is already your notification channel!`, flags: MessageFlags.Ephemeral});
                }
                guild.worldBossNotificationChannel = cmdInteraction.channelId;

                await Promise.allSettled([
                    this.db.updateGuild(guild.guildId, guild),
                    cmdInteraction.reply({content: `updated scouting channel to #${cmdInteraction.channel?.name}`, flags: MessageFlags.Ephemeral}),
                    this.initializeGuild(cmdInteraction.guildId, cmdInteraction.channelId)
                ]);
                break;
            }
        }
    }

    async stop() {
        if (this.longUpdatesInterval) {
            clearInterval(this.longUpdatesInterval);
        }
    }

    async start() {
        this.guilds = await this.db.allGuilds();
        log.info(`initializing ${this.guilds.length} guilds...`);

        this.bossData = Object.fromEntries(await Promise.all(this.guilds.map(async (guild) => {
            return [guild.guildId, await this.db.latestBossReport(guild.guildId) || emptyBossData()]      
        })));
        log.info(`loaded boss reports`);

        this.client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] });
        this.client.login(TOKEN).then(() => {}).catch(log.error);
        this.client.once('ready', async () => {
            log.info(`Logged in as ${this.client.user?.tag}`);
            await this.registerCommands();
            await this.findOrPostScoutingMessages();
        });
        this.client.on('guildCreate', async (guild: Guild) => {
            log.info(`[${guild.name}] new guild!`);
            const guildModel = {
                guildId: guild.id,
                worldBossFoundMessage: DEFAULT_BOSS_MESSAGE,
                worldBossRespawnMessage: DEFAULT_RESPAWN_MESSAGE,
                worldBossNotificationChannel: "",
                layerRespawnNotifications: true,
            }
            await this.db.updateGuild(guild.id, guildModel)
            this.guilds.push(guildModel);
            await this.registerCommands();
        })
       this.client.on('interactionCreate', async (interaction) => {
            if (interaction.isButton()) {
                await this.openScoutModal(interaction);
            } else if (interaction.isModalSubmit() && interaction.isFromMessage()) {
                await this.handleScoutSubmission(interaction);
            } else if (interaction.isChatInputCommand()) {
                await this.handleCommand(interaction);
            }
        });

        await this.startLongUpdates();
    }

    async openScoutModal(interaction: ButtonInteraction) {
        const [_, status, bossId] = interaction.customId.split('_');
        if (!this.bossData[interaction.guildId!][bossId]) return;

        const bossReport = this.bossData[interaction.guildId!];
        const boss = bossReport[bossId];

        const modal = new ModalBuilder()
            .setCustomId(`scout_modal_${bossId}_${status}`)
            .setTitle(`Scout ${boss.name}`)
            .addComponents(
                new ActionRowBuilder<TextInputBuilder>().addComponents(
                    new TextInputBuilder()
                            .setCustomId('boss-name')
                            .setLabel('Boss')
                            .setStyle(TextInputStyle.Short)
                            .setValue(boss.name)
                            .setRequired(true),
                    ),
                new ActionRowBuilder<TextInputBuilder>().addComponents(
                    new TextInputBuilder()
                        .setCustomId('layer')
                        .setLabel('Enter the Layer Number (1-9)')
                        .setStyle(TextInputStyle.Short)
                        .setRequired(true)
                )
            );

        await interaction.showModal(modal);
    }

    async handleScoutSubmission(interaction: ModalMessageModalSubmitInteraction) {
        const [_, __, bossId, status] = interaction.customId.split('_');
        const bossReport = this.bossData[interaction.guildId!] ?? emptyBossData();
        this.bossData[interaction.guildId!] = bossReport;

        if (!bossReport[bossId]) {
            log.error(`Unknown boss: ${bossId}`);
            return;
        } 

        const boss = bossReport[bossId];

        const layer = interaction.fields.getTextInputValue('layer');
        const layerData = boss.layers.find(l => l.layer === `Layer ${layer}`);
        if (!layerData) {
            await interaction.reply({ content: `Invalid layer selection.`, ephemeral: true });
            return;
        }

        layerData.status = status as BossStatus;
        layerData.lastScouted = new Date();

        if (layerData.status === 'alive') {
            if (interaction.channel?.isSendable()) {
                const msg = this.guilds.find(g => g.guildId === interaction.guildId)?.worldBossFoundMessage;
                if (msg === undefined) {
                    log.error(`Unknown guild: ${interaction.guild?.name}`);
                    return;
                }

                const content = msg.replace('%BOSS%', boss.name).replace("%LAYER%", layer);
                await interaction.channel.send({ content });
            } else {
                log.error(`Couldn't post notification, as channel ${interaction.channelId} is not sendable.`);
            }
        } else if (layerData.status === 'defeated') {
            boss.totalKills++;
        }

        if (layerData.status === 'defeated' || layerData.status === 'dead') {
            // determine respawn time.
            layerData.nextRespawn = getNextRespawnTime(new Date())
        }

        await this.db.updateBossReport(interaction.guildId!, bossReport);
        log.info("updated boss report", {guildId: interaction.guildId!, guild: interaction.guild?.name})

        await this.db.insertScoutReport({
            timestamp: new Date(), 
            guildId: interaction.guildId!,
            bossId: bossId,
            layerId: layer,
            state: status as BossStatus, // state the boss was in 
            reporterId: interaction.user.id, // user who reported the boss
        })
        log.info("updated scout report", {guildId: interaction.guildId!, guild: interaction.guild?.name})
        await this.updateScoutingMessages(interaction.guildId!, interaction.channelId, {interaction, bossId});
    }
}

