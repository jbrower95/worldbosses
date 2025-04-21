import { Client, GatewayIntentBits, REST, Routes, TextChannel, ActionRowBuilder, ButtonInteraction, ModalBuilder, TextInputBuilder, TextInputStyle, ModalMessageModalSubmitInteraction, ChatInputCommandInteraction, SlashCommandBuilder, Guild, MessageFlags, Message } from 'discord.js';
import { BossData, BossStatus, IBossReport, IDatabase, IGuild, TBossId, TResponseInfo } from './types';
import { createActionRow, formatBossStatus, getNextRespawnTime, BOSSES, emptyBossData} from './utils';
import { log } from './log';
import { copyGuild } from './types';

const TOKEN = process.env.DISCORD_BOT_TOKEN || '';
const CLIENT_ID = process.env.DISCORD_CLIENT_ID || '';

const DEFAULT_BOSS_MESSAGE = `@everyone %BOSS% is up on layer %LAYER%!`;
const DEFAULT_RESPAWN_MESSAGE = `%BOSS% will respawn soon on layer %LAYER%.`

type TCommandType = 'scouting-notifications-toggle' | 'scouting-message' | 'scouting-channel' | 'scouting-message-bring-down' | 'scouting-message-clear' | 'scouting-set-layers';

const ONE_HOUR = 1000 * 60 * 60;

const commands = [
    {
        name: 'scouting-set-layers',
        description: 'Set the number of layers to display',
        options: [{
            type: 4,
            name: 'num_layers',
            description: 'The number of layers to show',
            required: true,
            min_value: 1,
            max_value: 10
        }]
    },
    {
        name: 'scouting-notifications-toggle',
        description: 'Enable or disable notifications for scouting. (Owner only).',
    },
    {
        name: 'scouting-channel',
        description: 'Make the current channel the scouting channel. (Owner only).',
    },
    {
        name: 'scouting-message-bring-down',
        description: 'Move the scouting message in the current channel downward, resetting the contents.'
    },
    {
        name: 'scouting-message-clear',
        description: 'Removes the scouting message in this thread.'
    }
] as {name: TCommandType, description: string}[];

type TGuildId = string;

export class Bot {
    bossData: Record<TGuildId, IBossReport>;
    client: Client<boolean>
    guilds: Record<string, IGuild>

    longUpdatesInterval: NodeJS.Timeout | undefined;

    constructor(private db: IDatabase) {
        this.bossData = {};
    }
    
    async registerCommands() {
        const rest = new REST({ version: '10' }).setToken(TOKEN);
        for (const guildId of Object.keys(this.guilds)) {
            try {
                await rest.put(Routes.applicationGuildCommands(CLIENT_ID, guildId), { body: commands });
            } catch (e) {
                log.error("failed to register commands for guild", {guild: guildId});
            }
        }
        log.info('/slash commands registered');
    }
    
    async findOrPostScoutingMessages() {
        for (const guildId of Object.keys(this.guilds)) {
            const guild = this.guilds[guildId];
            try {
                await this.initializeGuild(guild.guildId, guild, guild.worldBossNotificationChannel);
            } catch (e) {
                log.error("failed to initialize guild", {guild: guild.guildId, error: e});
            }
        }
    }

    async startLongUpdates() {
        this.longUpdatesInterval = setInterval(async () => {
            // check periodically if any of the bosses statuses are respawned.
            for (let guild of Object.keys(this.bossData)) {
                const guildInfo = this.guilds[guild];
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

    async initializeGuild(guildId: string, guild: IGuild, scoutingChannel: string) {
        const channel = await this.client.channels.fetch(scoutingChannel) as TextChannel;
        if (!channel) {
            log.info(`Couldn't find #scouting channel.`);
            return;
        }

        const bossData = this.bossData[guildId] ?? emptyBossData();
        this.bossData[guildId] = bossData;
    
        const messages = await channel.messages.fetch({ limit: 50 });
        for (const boss of BOSSES) {
            const existingMessage = messages.find(msg => msg.content.includes(boss.name) && msg.author.id === this.client.user!.id);
            if (existingMessage) {
                log.info(`found existing post for ${boss.name}`, {guildId: channel.guild.id, guild: channel.guild.name})
                bossData[boss.id] = {
                    ...(bossData[boss.id] || {}),
                    messageId: existingMessage.id
                };
                try {
                    if (!existingMessage.pinned) {
                        await existingMessage.pin();
                    }
                } catch (e) {
                    log.error(`failed to pin message`, {guild: guildId, error: e});
                }
            } else {
                log.info(`creating post for ${boss.name}`, {guildId: channel.guild.id, guild: channel.guild.name})
                const message = await channel.send({ content: formatBossStatus(this.bossData[guildId][boss.id], guild.numLayers ?? 4), components: createActionRow(boss) });
                bossData[boss.id] = {
                    ...(bossData[boss.id] || {}),
                    messageId: message.id
                };
                try {
                    await message.pin();
                } catch (e){
                    log.error(`failed to pin message`, {guild: guildId, error: e});
                }
            }
        }
    }

    async updateScoutingMessages(guildId: string, scoutingChannel: string, response?: TResponseInfo) {
        const channel = await this.client.channels.fetch(scoutingChannel) as TextChannel;
        if (!channel) return;

        const bossData = this.bossData[guildId] ?? emptyBossData();
        this.bossData[guildId] = bossData;

        const guild = await this.db.guildById(guildId);
        if (!guild) {
            log.error(`failed to find guild: ${guildId}`);
            return;
        }
    
        if (response !== undefined) {
            // update specific post
            const bossInfo = bossData[response.bossId];
            await response.interaction.update({content: formatBossStatus(bossInfo, guild.numLayers ?? 4), components: createActionRow(bossInfo)})
            return;
        } else {
            // update all
            for (const boss of BOSSES) {
                const bossInfo = bossData[boss.id];
                if (bossInfo.messageId) {
                    try {
                        const message = await channel.messages.fetch(bossInfo.messageId);
                        await message.edit({ content: formatBossStatus(bossInfo, guild.numLayers ?? 4), components: createActionRow(bossInfo) });
                        try {
                            await message.pin();
                        } catch (e) {
                            log.error(`failed to pin messsage`, {guildId, boss: boss.id});
                        }
                    } catch (error) {
                        log.error(`Failed to update scouting message for ${boss}:`, error);
                    }
                }
            }
        }
    }

    async updateGuild(guildId: string, contents: IGuild): Promise<void> {
        if (this.guilds[guildId] !== undefined) {
            delete this.guilds[guildId];
        }
        this.guilds[guildId] = contents;
        await this.db.updateGuild(guildId, contents);
    }

    async handleCommand(cmdInteraction: ChatInputCommandInteraction<any>) {
        const guild = this.guilds[cmdInteraction.guildId];
        if (!guild) {
            return await cmdInteraction.reply("experienced an error");
        }

        const cmdName: TCommandType = cmdInteraction.commandName as TCommandType;
        
        switch (cmdName) {
            case 'scouting-set-layers': {
                if (guild.worldBossNotificationChannel !== cmdInteraction.channelId) {
                    return await cmdInteraction.reply({content: `#${cmdInteraction.channel?.name} is not your notification channel!`, flags: MessageFlags.Ephemeral});
                }
                if (!cmdInteraction.channel) {
                    return await cmdInteraction.reply({content: `Internal error.`, flags: MessageFlags.Ephemeral});
                }

                try {
                    const newLayers = cmdInteraction.options.getInteger('num_layers') ?? 5;
                    await this.updateGuild(guild.guildId, {
                        ...copyGuild(guild),
                        numLayers: newLayers
                    })
                    await cmdInteraction.reply({content: `now showing ${newLayers} layers!`, flags: MessageFlags.Ephemeral});
                    await this.updateScoutingMessages(guild.guildId, guild.worldBossNotificationChannel)
                    break;
                } catch (e) {
                    log.error(e);
                    return await cmdInteraction.reply({content: "experienced an error", flags: MessageFlags.Ephemeral});
                }
            }
            case 'scouting-message-clear': {
                if (guild.worldBossNotificationChannel !== cmdInteraction.channelId) {
                    return await cmdInteraction.reply({content: `#${cmdInteraction.channel?.name} is not your notification channel!`, flags: MessageFlags.Ephemeral});
                }
                if (!cmdInteraction.channel) {
                    return await cmdInteraction.reply({content: `Internal error.`, flags: MessageFlags.Ephemeral});
                }

                let numMessages = 0;
                try {
                    const msgs = await cmdInteraction.channel.messages.fetch();

                    const posts = msgs.filter((msg) => msg.author.id === this.client.user!.id);
                    await cmdInteraction.deferReply(); // this could take a second.
                
                    await Promise.allSettled(posts.map(async (msg) => {
                        numMessages++;
                        await msg.delete();
                    }));

                    await cmdInteraction.followUp({content: `removed ${numMessages} posts.`, flags: MessageFlags.Ephemeral});
                } catch (e) {
                    await cmdInteraction.followUp({content: `failed to remove ${numMessages} messages.`, flags: MessageFlags.Ephemeral});
                    log.error(e);
                }
                break;
            }
            case 'scouting-message-bring-down': {
                if (guild.worldBossNotificationChannel !== cmdInteraction.channelId) {
                    return await cmdInteraction.reply({content: `#${cmdInteraction.channel?.name} is not your notification channel!`, flags: MessageFlags.Ephemeral});
                }
                if (!cmdInteraction.channel) {
                    return await cmdInteraction.reply({content: `Internal error.`, flags: MessageFlags.Ephemeral});
                }

                // remove the existing messages.
                const bossData = this.bossData[guild.guildId] ?? emptyBossData();
                for (const bossName of Object.keys(bossData)) {
                    const boss: BossData = bossData[bossName];
                    try {
                        if (boss.messageId) {
                            const msg = await cmdInteraction.channel.messages.fetch(boss.messageId);
                            try {
                                await msg.delete();
                            } catch {
                                log.error("failed to delete message")
                            }
                        }
                    } catch (e) {
                        // it's always possible the message doesn't exist.
                        log.error('message doesnt exist anymore', boss.messageId);
                    }
                    bossData[bossName] = {
                        ...(bossData[bossName] || {}),
                        messageId: undefined
                    };
                }
                await this.initializeGuild(cmdInteraction.guildId, guild, cmdInteraction.channelId);
                await cmdInteraction.reply({content: `reset scouting message!`, flags: MessageFlags.Ephemeral})
                break;
            }
            case 'scouting-notifications-toggle': {
                guild.layerRespawnNotifications = !guild.layerRespawnNotifications;
                await this.updateGuild(guild.guildId, guild);
                await cmdInteraction.reply(`toggled notifications ${guild.layerRespawnNotifications ? 'on' : 'off'}!`);
                break;
            }
            case 'scouting-channel': {
                if (guild.worldBossNotificationChannel === cmdInteraction.channelId) {
                    return await cmdInteraction.reply({content: `#${cmdInteraction.channel?.name} is already your notification channel!`, flags: MessageFlags.Ephemeral});
                }
                guild.worldBossNotificationChannel = cmdInteraction.channelId;

                await Promise.allSettled([
                    this.updateGuild(guild.guildId, guild),
                    cmdInteraction.reply({content: `updated scouting channel to #${cmdInteraction.channel?.name}`, flags: MessageFlags.Ephemeral})
                ]);
                await this.initializeGuild(cmdInteraction.guildId, guild, cmdInteraction.channelId);
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

        this.bossData = Object.fromEntries(await Promise.all(Object.values(this.guilds).map(async (guild) => {
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
            const guildModel: IGuild = {
                guildId: guild.id,
                worldBossFoundMessage: DEFAULT_BOSS_MESSAGE,
                worldBossRespawnMessage: DEFAULT_RESPAWN_MESSAGE,
                worldBossNotificationChannel: "",
                layerRespawnNotifications: true,
                numLayers: 4 // default number of layers.
            }
            await this.updateGuild(guild.id, guildModel)
            await this.registerCommands();
        })
       this.client.on('interactionCreate', async (interaction) => {
            if (interaction.isButton()) {
                await this.openScoutModal(interaction);
            } else if (interaction.isModalSubmit() && interaction.isFromMessage()) {
                if (interaction.customId.startsWith(`scout_modal_`)) {
                    await this.handleScoutSubmission(interaction);
                } 
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
                const msg = this.guilds[interaction.guildId!]?.worldBossFoundMessage;
                if (msg === undefined) {
                    log.error(`Unknown guild: ${interaction.guild?.name}`);
                    return;
                }

                const content = msg.replace('%BOSS%', boss.name).replace("%LAYER%", layer);
                await interaction.channel.send({ content });
            } else {
                log.error(`Couldn't post notification, as channel ${interaction.channelId} is not sendable.`);
            }
        } else { }

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

