(function () {
  'use strict';

  const $  = (sel, ctx) => (ctx || document).querySelector(sel);
  const $$ = (sel, ctx) => Array.from((ctx || document).querySelectorAll(sel));

  const projectFiles = {
    round: {
      name: 'Simple Round System',
      files: {
        'ClientMain.lua': `--!strict
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local RunService = game:GetService("RunService")
local Players = game:GetService("Players")

local Maid = require(ReplicatedStorage:WaitForChild("SharedModules"):WaitForChild("Maid"))

local player: Player = assert(Players.LocalPlayer, "ClientMain requires LocalPlayer")

local Events = ReplicatedStorage:WaitForChild("Events")
local TimeSyncEvent: RemoteEvent = Events:WaitForChild("TimeSyncEvent") :: RemoteEvent

local currentEndTime: number = 0
local uiUpdateMaid = Maid.new()
local lifetimeMaid = Maid.new()

local function formatTime(seconds: number): string
	local clamped = math.max(0, seconds)
	local minutes = math.floor(clamped / 60)
	local secs = math.floor(clamped % 60)
	return string.format("%02d:%02d", minutes, secs)
end

local function startUIUpdate(): ()
	uiUpdateMaid:DoCleaning()
	local playerGui = player:WaitForChild("PlayerGui") :: PlayerGui
	local roundGui = playerGui:WaitForChild("RoundGui")
	local label = roundGui:WaitForChild("TimerLabel")
	if not label:IsA("TextLabel") then
		return
	end
	local timerLabel: TextLabel = label
	uiUpdateMaid:GiveTask(RunService.RenderStepped:Connect(function(_dt: number): ()
		local remaining = currentEndTime - workspace:GetServerTimeNow()
		if remaining <= 0 then
			timerLabel.Text = "00:00"
			uiUpdateMaid:DoCleaning()
			return
		end
		timerLabel.Text = formatTime(remaining)
	end))
end

lifetimeMaid:GiveTask(TimeSyncEvent.OnClientEvent:Connect(function(endTime: number): ()
	currentEndTime = endTime
	startUIUpdate()
end))

lifetimeMaid:GiveTask(player.CharacterAdded:Connect(function(_character: Model): ()
	if currentEndTime > workspace:GetServerTimeNow() then
		startUIUpdate()
	end
end))`,

        'ClientSwordController.lua': `--!strict
local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")

local Maid = require(ReplicatedStorage:WaitForChild("SharedModules"):WaitForChild("Maid"))

local Events = ReplicatedStorage:WaitForChild("Events")
local SwordHitEvent: RemoteEvent = Events:WaitForChild("SwordHitEvent") :: RemoteEvent

local ATTACK_COOLDOWN = 0.5

type ControllerImpl = {
	__index: ControllerImpl,
	new: (tool: Tool) -> Controller,
	Connect: (self: Controller) -> (),
	Destroy: (self: Controller) -> (),
	_onActivated: (self: Controller) -> (),
	_onEquipped: (self: Controller) -> (),
	_onUnequipped: (self: Controller) -> (),
}

type Controller = typeof(setmetatable(
	{} :: {
		Tool: Tool,
		_maid: Maid.Maid,
		_equipMaid: Maid.Maid,
		_lastAttack: number,
	},
	{} :: ControllerImpl
))

local Controller = {} :: ControllerImpl
Controller.__index = Controller

function Controller.new(tool: Tool): Controller
	local self = {
		Tool = tool,
		_maid = Maid.new(),
		_equipMaid = Maid.new(),
		_lastAttack = 0,
	}
	return setmetatable(self, Controller) :: Controller
end

function Controller._onActivated(self: Controller): ()
	local now = os.clock()
	if now - self._lastAttack < ATTACK_COOLDOWN then
		return
	end
	local localPlayer = Players.LocalPlayer
	if localPlayer == nil then
		return
	end
	local character = localPlayer.Character
	if character == nil then
		return
	end
	if character:FindFirstChild("HumanoidRootPart") == nil then
		return
	end
	self._lastAttack = now
	SwordHitEvent:FireServer()
end

function Controller._onEquipped(self: Controller): ()
	self._equipMaid:DoCleaning()
	self._equipMaid:GiveTask(self.Tool.Activated:Connect(function(): ()
		self:_onActivated()
	end))
end

function Controller._onUnequipped(self: Controller): ()
	self._equipMaid:DoCleaning()
end

function Controller.Connect(self: Controller): ()
	self._maid:GiveTask(self.Tool.Equipped:Connect(function(): ()
		self:_onEquipped()
	end))
	self._maid:GiveTask(self.Tool.Unequipped:Connect(function(): ()
		self:_onUnequipped()
	end))
end

function Controller.Destroy(self: Controller): ()
	self._equipMaid:DoCleaning()
	self._maid:DoCleaning()
end

local parent = script.Parent
if parent ~= nil and parent:IsA("Tool") then
	local toolInstance: Tool = parent
	local controller = Controller.new(toolInstance)
	controller:Connect()
	toolInstance.AncestryChanged:Connect(function(_child: Instance, newParent: Instance?): ()
		if newParent == nil then
			controller:Destroy()
		end
	end)
end`,

        'DataManager.lua': `--!strict
local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")

local Maid = require(ReplicatedStorage.SharedModules.Maid)

type ProfileData = {
	Wins: number,
	Coins: number,
}

export type Profile = {
	Data: ProfileData,
	Release: (Profile) -> (),
	ListenToRelease: (Profile, () -> ()) -> (),
}

type ProfileStore = {
	LoadProfileAsync: (ProfileStore, profileKey: string, notReleasedHandler: string) -> Profile?,
}

type ProfileServiceLib = {
	GetProfileStore: (dataStoreName: string, profileTemplate: ProfileData) -> ProfileStore,
}

local ProfileService: ProfileServiceLib = (require(script.Parent.ProfileService) :: any) :: ProfileServiceLib

local PROFILE_TEMPLATE: ProfileData = {
	Wins = 0,
	Coins = 0,
}

type DataManagerImpl = {
	__index: DataManagerImpl,
	new: () -> DataManager,
	GetProfile: (self: DataManager, player: Player) -> Profile?,
	AddWins: (self: DataManager, player: Player, amount: number) -> (),
	AddCoins: (self: DataManager, player: Player, amount: number) -> (),
	Destroy: (self: DataManager) -> (),
	_initialize: (self: DataManager) -> (),
	_onPlayerAdded: (self: DataManager, player: Player) -> (),
	_onPlayerRemoving: (self: DataManager, player: Player) -> (),
	_createLeaderstats: (self: DataManager, player: Player, profile: Profile) -> (),
	_updateLeaderstats: (self: DataManager, player: Player, profile: Profile) -> (),
}

export type DataManager = typeof(setmetatable(
	{} :: {
		_maid: Maid.Maid,
		_profiles: { [Player]: Profile },
		_profileStore: ProfileStore,
	},
	{} :: DataManagerImpl
))

local DataManager = {} :: DataManagerImpl
DataManager.__index = DataManager

function DataManager.new(): DataManager
	local self = {
		_maid = Maid.new(),
		_profiles = {} :: { [Player]: Profile },
		_profileStore = ProfileService.GetProfileStore("PlayerData_v1", PROFILE_TEMPLATE),
	}
	local instance = setmetatable(self, DataManager) :: DataManager
	instance:_initialize()
	return instance
end

function DataManager._initialize(self: DataManager): ()
	self._maid:GiveTask(Players.PlayerAdded:Connect(function(player: Player): ()
		self:_onPlayerAdded(player)
	end))
	self._maid:GiveTask(Players.PlayerRemoving:Connect(function(player: Player): ()
		self:_onPlayerRemoving(player)
	end))
	for _, player in Players:GetPlayers() do
		task.spawn(function(): ()
			self:_onPlayerAdded(player)
		end)
	end
end

function DataManager._createLeaderstats(self: DataManager, player: Player, profile: Profile): ()
	local leaderstats = Instance.new("Folder")
	leaderstats.Name = "leaderstats"
	local winsValue = Instance.new("IntValue")
	winsValue.Name = "Wins"
	winsValue.Value = profile.Data.Wins
	winsValue.Parent = leaderstats
	local coinsValue = Instance.new("IntValue")
	coinsValue.Name = "Coins"
	coinsValue.Value = profile.Data.Coins
	coinsValue.Parent = leaderstats
	leaderstats.Parent = player
end

function DataManager._updateLeaderstats(self: DataManager, player: Player, profile: Profile): ()
	local leaderstats = player:FindFirstChild("leaderstats")
	if leaderstats == nil then
		return
	end
	local winsValue = leaderstats:FindFirstChild("Wins")
	local coinsValue = leaderstats:FindFirstChild("Coins")
	if winsValue ~= nil and winsValue:IsA("IntValue") then
		winsValue.Value = profile.Data.Wins
	end
	if coinsValue ~= nil and coinsValue:IsA("IntValue") then
		coinsValue.Value = profile.Data.Coins
	end
end

function DataManager._onPlayerAdded(self: DataManager, player: Player): ()
	local ok, result = pcall(function(): Profile?
		return self._profileStore:LoadProfileAsync("Player_" .. player.UserId, "ForceLoad")
	end)
	if not ok or result == nil then
		if player.Parent == Players then
			player:Kick("Data loading failed. Please rejoin.")
		end
		return
	end
	local loaded: Profile = result :: Profile
	if player.Parent ~= Players then
		loaded:Release()
		return
	end
	loaded:ListenToRelease(function(): ()
		self._profiles[player] = nil
		if player.Parent == Players then
			player:Kick("Data session terminated elsewhere.")
		end
	end)
	self._profiles[player] = loaded
	self:_createLeaderstats(player, loaded)
end

function DataManager._onPlayerRemoving(self: DataManager, player: Player): ()
	local profile = self._profiles[player]
	if profile ~= nil then
		profile:Release()
		self._profiles[player] = nil
	end
end

function DataManager.GetProfile(self: DataManager, player: Player): Profile?
	return self._profiles[player]
end

function DataManager.AddWins(self: DataManager, player: Player, amount: number): ()
	local profile = self._profiles[player]
	if profile == nil then
		return
	end
	profile.Data.Wins += amount
	self:_updateLeaderstats(player, profile)
end

function DataManager.AddCoins(self: DataManager, player: Player, amount: number): ()
	local profile = self._profiles[player]
	if profile == nil then
		return
	end
	profile.Data.Coins += amount
	self:_updateLeaderstats(player, profile)
end

function DataManager.Destroy(self: DataManager): ()
	self._maid:DoCleaning()
	local profiles = self._profiles
	self._profiles = {} :: { [Player]: Profile }
	for _, profile in pairs(profiles) do
		profile:Release()
	end
end

return DataManager`,

        'GameConfig.lua': `--!strict

export type Config = {
	INTERMISSION_DURATION: number,
	INGAME_DURATION: number,
	CLEANUP_DURATION: number,
	MIN_PLAYERS: number,
	SWORD_DAMAGE: number,
	SWORD_DEBOUNCE: number,
	MAX_DAMAGE_DISTANCE: number,
	SPHERECAST_RANGE: number,
	SPHERECAST_RADIUS: number,
	WIN_COINS: number,
	WIN_AMOUNT: number,
}

local GameConfig: Config = {
	INTERMISSION_DURATION = 15,
	INGAME_DURATION = 30,
	CLEANUP_DURATION = 5,
	MIN_PLAYERS = 2,
	SWORD_DAMAGE = 20,
	SWORD_DEBOUNCE = 0.5,
	MAX_DAMAGE_DISTANCE = 10,
	SPHERECAST_RANGE = 5,
	SPHERECAST_RADIUS = 1,
	WIN_COINS = 50,
	WIN_AMOUNT = 1,
}

return table.freeze(GameConfig)`,

        'Maid.lua': `--!strict

export type MaidTask = RBXScriptConnection
	| Instance
	| thread
	| () -> ()
	| { Destroy: (any) -> () }

type MaidImpl = {
	__index: MaidImpl,
	new: () -> Maid,
	GiveTask: (self: Maid, item: MaidTask?) -> MaidTask?,
	DoCleaning: (self: Maid) -> (),
	Destroy: (self: Maid) -> (),
	IsCleaning: (self: Maid) -> boolean,
}

export type Maid = typeof(setmetatable(
	{} :: { _tasks: { [any]: MaidTask } },
	{} :: MaidImpl
))

local Maid = {} :: MaidImpl
Maid.__index = Maid

function Maid.new(): Maid
	local self = {
		_tasks = {} :: { [any]: MaidTask },
	}
	return setmetatable(self, Maid) :: Maid
end

function Maid.GiveTask(self: Maid, item: MaidTask?): MaidTask?
	if item == nil then
		return nil
	end
	self._tasks[item] = item
	return item
end

function Maid.DoCleaning(self: Maid): ()
	local tasks = self._tasks
	self._tasks = {} :: { [any]: MaidTask }
	for tracked in pairs(tasks) do
		local kind = typeof(tracked)
		pcall(function(): ()
			if kind == "function" then
				(tracked :: () -> ())()
			elseif kind == "RBXScriptConnection" then
				(tracked :: RBXScriptConnection):Disconnect()
			elseif kind == "thread" then
				local thr = tracked :: thread
				if coroutine.status(thr) ~= "dead" then
					task.cancel(thr)
				end
			elseif kind == "Instance" then
				(tracked :: Instance):Destroy()
			elseif kind == "table" then
				local destroyable = tracked :: { Destroy: (any) -> () }
				if typeof(destroyable.Destroy) == "function" then
					destroyable:Destroy()
				end
			end
		end)
	end
end

function Maid.Destroy(self: Maid): ()
	self:DoCleaning()
end

function Maid.IsCleaning(self: Maid): boolean
	return next(self._tasks) == nil
end

return Maid`,

        'Main.lua': `--!strict
local ServerScriptService = game:GetService("ServerScriptService")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Players = game:GetService("Players")

local Maid = require(ReplicatedStorage.SharedModules.Maid)
local GameConfig = require(ReplicatedStorage.SharedModules.GameConfig)
local ServerModules = ServerScriptService:WaitForChild("ServerModules")
local TimerService = require(ServerModules:WaitForChild("TimerService"))
local RoundManagerSingleton = require(ServerModules:WaitForChild("RoundManagerSingleton"))
local ServerSwordHandler = require(ServerModules:WaitForChild("ServerSwordHandler"))

local INTERMISSION_DURATION = GameConfig.INTERMISSION_DURATION
local INGAME_DURATION = GameConfig.INGAME_DURATION
local CLEANUP_DURATION = GameConfig.CLEANUP_DURATION
local MIN_PLAYERS = GameConfig.MIN_PLAYERS

local mainMaid = Maid.new()
local perPlayerConnections: { [Player]: { RBXScriptConnection } } = {}

ServerSwordHandler.Start()

local function teleportLateJoinerToLobby(player: Player): ()
	task.wait(0.5)
	local state = RoundManagerSingleton:GetCurrentState()
	if state ~= "Lobby" and state ~= "Intermission" then
		return
	end
	RoundManagerSingleton:SendPlayerToLobby(player)
end

local function runIteration(): ()
	RoundManagerSingleton:TransitionToState("Intermission")
	TimerService.StartTimer(INTERMISSION_DURATION)
	task.wait(INTERMISSION_DURATION)
	if #Players:GetPlayers() < MIN_PLAYERS then
		task.wait(5)
		return
	end
	RoundManagerSingleton:TransitionToState("InGame")
	TimerService.StartTimer(INGAME_DURATION)
	local roundEnded = RoundManagerSingleton.RoundEnded
	local timeoutThread = task.delay(INGAME_DURATION, function(): ()
		roundEnded:Fire()
	end)
	roundEnded.Event:Wait()
	if coroutine.status(timeoutThread) ~= "dead" then
		task.cancel(timeoutThread)
	end
	RoundManagerSingleton:TransitionToState("Cleanup")
	TimerService.StartTimer(CLEANUP_DURATION)
	task.wait(CLEANUP_DURATION)
end

local function runGameLoop(): ()
	RoundManagerSingleton:TransitionToState("Lobby")
	while true do
		local ok, err = pcall(runIteration)
		if not ok then
			warn("[Main] iteration failed:", err)
			pcall(function(): ()
				RoundManagerSingleton:TransitionToState("Lobby")
			end)
			task.wait(5)
		end
	end
end

mainMaid:GiveTask(Players.PlayerAdded:Connect(function(player: Player): ()
	local conns: { RBXScriptConnection } = {}
	perPlayerConnections[player] = conns
	table.insert(conns, player.CharacterAdded:Connect(function(_character: Model): ()
		teleportLateJoinerToLobby(player)
	end))
end))

mainMaid:GiveTask(Players.PlayerRemoving:Connect(function(player: Player): ()
	local conns = perPlayerConnections[player]
	if conns == nil then
		return
	end
	for _, c in conns do
		c:Disconnect()
	end
	perPlayerConnections[player] = nil
end))

mainMaid:GiveTask(task.spawn(runGameLoop))`,

        'PlayerManager.lua': `--!strict
local Players = game:GetService("Players")
local ServerStorage = game:GetService("ServerStorage")

local SWORD_TOOL_NAME = "ClassicSword"

type PlayerManagerImpl = {
	__index: PlayerManagerImpl,
	new: () -> PlayerManager,
	IsPlayerAlive: (self: PlayerManager, player: Player) -> boolean,
	GetAlivePlayers: (self: PlayerManager) -> { Player },
	TeleportPlayersTo: (self: PlayerManager, players: { Player }, destinationFolder: Folder) -> (),
	GiveSword: (self: PlayerManager, player: Player) -> Tool?,
	ClearSwords: (self: PlayerManager, player: Player) -> (),
	Destroy: (self: PlayerManager) -> (),
}

export type PlayerManager = typeof(setmetatable(
	{} :: {},
	{} :: PlayerManagerImpl
))

local PlayerManager = {} :: PlayerManagerImpl
PlayerManager.__index = PlayerManager

function PlayerManager.new(): PlayerManager
	return setmetatable({}, PlayerManager) :: PlayerManager
end

function PlayerManager.IsPlayerAlive(_self: PlayerManager, player: Player): boolean
	local character = player.Character
	if character == nil then
		return false
	end
	local humanoid = character:FindFirstChildOfClass("Humanoid")
	if humanoid == nil then
		return false
	end
	return humanoid.Health > 0
end

function PlayerManager.GetAlivePlayers(self: PlayerManager): { Player }
	local alive: { Player } = {}
	for _, player in Players:GetPlayers() do
		if self:IsPlayerAlive(player) then
			table.insert(alive, player)
		end
	end
	return alive
end

function PlayerManager.TeleportPlayersTo(_self: PlayerManager, players: { Player }, destinationFolder: Folder): ()
	local validParts: { BasePart } = {}
	for _, child in destinationFolder:GetChildren() do
		if child:IsA("BasePart") then
			table.insert(validParts, child)
		end
	end
	if #validParts == 0 then
		return
	end
	for _, player in players do
		local character = player.Character
		if character == nil then
			continue
		end
		local target = validParts[math.random(1, #validParts)]
		pcall(function(): ()
			character:PivotTo(target.CFrame + Vector3.new(0, 3, 0))
		end)
	end
end

function PlayerManager.GiveSword(_self: PlayerManager, player: Player): Tool?
	local template = ServerStorage:FindFirstChild(SWORD_TOOL_NAME)
	if template == nil or not template:IsA("Tool") then
		return nil
	end
	local backpack = player:FindFirstChildOfClass("Backpack")
	if backpack == nil then
		return nil
	end
	local clone = template:Clone()
	clone.CanBeDropped = false
	clone.Parent = backpack
	return clone
end

function PlayerManager.ClearSwords(_self: PlayerManager, player: Player): ()
	local backpack = player:FindFirstChildOfClass("Backpack")
	if backpack ~= nil then
		for _, child in backpack:GetChildren() do
			if child:IsA("Tool") and child.Name == SWORD_TOOL_NAME then
				child:Destroy()
			end
		end
	end
	local character = player.Character
	if character ~= nil then
		for _, child in character:GetChildren() do
			if child:IsA("Tool") and child.Name == SWORD_TOOL_NAME then
				child:Destroy()
			end
		end
	end
end

function PlayerManager.Destroy(_self: PlayerManager): ()
end

return PlayerManager`,

        'RoundManager.lua': `--!strict
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Players = game:GetService("Players")

local Maid = require(ReplicatedStorage.SharedModules.Maid)
local GameConfig = require(ReplicatedStorage.SharedModules.GameConfig)
local PlayerManager = require(script.Parent.PlayerManager)
local DataManager = require(script.Parent.DataManager)

export type RoundState = "Lobby" | "Intermission" | "InGame" | "Cleanup"

type RoundManagerImpl = {
	__index: RoundManagerImpl,
	new: () -> RoundManager,
	GetCurrentState: (self: RoundManager) -> RoundState,
	IsParticipant: (self: RoundManager, player: Player) -> boolean,
	TransitionToState: (self: RoundManager, newState: RoundState) -> (),
	SendPlayerToLobby: (self: RoundManager, player: Player) -> (),
	StartLobby: (self: RoundManager) -> (),
	StartIntermission: (self: RoundManager) -> (),
	StartGame: (self: RoundManager) -> (),
	StartCleanup: (self: RoundManager) -> (),
	CheckWinCondition: (self: RoundManager, excludePlayer: Player?) -> (),
	Destroy: (self: RoundManager) -> (),
	_findLobby: (self: RoundManager) -> Folder?,
	_findArena: (self: RoundManager) -> Folder?,
}

export type RoundManager = typeof(setmetatable(
	{} :: {
		CurrentState: RoundState,
		PreviousState: RoundState?,
		CurrentMaid: Maid.Maid,
		RoundEnded: BindableEvent,
		Participants: { [Player]: true },
		Winner: Player?,
		_playerManager: PlayerManager.PlayerManager,
		_dataManager: DataManager.DataManager,
	},
	{} :: RoundManagerImpl
))

local RoundManager = {} :: RoundManagerImpl
RoundManager.__index = RoundManager

function RoundManager.new(): RoundManager
	local maid = Maid.new()
	local roundEnded = Instance.new("BindableEvent")
	maid:GiveTask(roundEnded)
	local self = {
		CurrentState = "Lobby" :: RoundState,
		PreviousState = nil :: RoundState?,
		CurrentMaid = maid,
		RoundEnded = roundEnded,
		Participants = {} :: { [Player]: true },
		Winner = nil :: Player?,
		_playerManager = PlayerManager.new(),
		_dataManager = DataManager.new(),
	}
	return setmetatable(self, RoundManager) :: RoundManager
end

function RoundManager.GetCurrentState(self: RoundManager): RoundState
	return self.CurrentState
end

function RoundManager.IsParticipant(self: RoundManager, player: Player): boolean
	return self.Participants[player] == true
end

function RoundManager._findLobby(_self: RoundManager): Folder?
	local map = workspace:FindFirstChild("Map")
	if map == nil then
		return nil
	end
	local lobby = map:FindFirstChild("Lobby")
	if lobby ~= nil and lobby:IsA("Folder") then
		return lobby
	end
	return nil
end

function RoundManager._findArena(_self: RoundManager): Folder?
	local map = workspace:FindFirstChild("Map")
	if map == nil then
		return nil
	end
	local arena = map:FindFirstChild("Arena")
	if arena ~= nil and arena:IsA("Folder") then
		return arena
	end
	return nil
end

function RoundManager.TransitionToState(self: RoundManager, newState: RoundState): ()
	if newState == self.CurrentState then
		return
	end
	self.CurrentMaid:DoCleaning()
	self.PreviousState = self.CurrentState
	self.CurrentState = newState
	local newMaid = Maid.new()
	local newRoundEnded = Instance.new("BindableEvent")
	newMaid:GiveTask(newRoundEnded)
	self.CurrentMaid = newMaid
	self.RoundEnded = newRoundEnded
	if newState == "Lobby" then
		self:StartLobby()
	elseif newState == "Intermission" then
		self:StartIntermission()
	elseif newState == "InGame" then
		self:StartGame()
	elseif newState == "Cleanup" then
		self:StartCleanup()
	end
end

function RoundManager.SendPlayerToLobby(self: RoundManager, player: Player): ()
	local lobby = self:_findLobby()
	if lobby == nil then
		return
	end
	self._playerManager:TeleportPlayersTo({ player }, lobby)
end

function RoundManager.StartLobby(self: RoundManager): ()
	self.Participants = {}
	self.Winner = nil
	local lobby = self:_findLobby()
	if lobby == nil then
		return
	end
	local allPlayers = Players:GetPlayers()
	self._playerManager:TeleportPlayersTo(allPlayers, lobby)
	for _, player in allPlayers do
		self._playerManager:ClearSwords(player)
	end
end

function RoundManager.StartIntermission(self: RoundManager): ()
	self.Participants = {}
	self.Winner = nil
	local lobby = self:_findLobby()
	if lobby == nil then
		return
	end
	local allPlayers = Players:GetPlayers()
	self._playerManager:TeleportPlayersTo(allPlayers, lobby)
	for _, player in allPlayers do
		self._playerManager:ClearSwords(player)
	end
end

function RoundManager.StartGame(self: RoundManager): ()
	local arena = self:_findArena()
	if arena == nil then
		return
	end
	local alivePlayers = self._playerManager:GetAlivePlayers()
	if #alivePlayers < GameConfig.MIN_PLAYERS then
		return
	end
	local participants: { [Player]: true } = {}
	for _, player in alivePlayers do
		participants[player] = true
	end
	self.Participants = participants
	self.Winner = nil
	self._playerManager:TeleportPlayersTo(alivePlayers, arena)
	for _, player in alivePlayers do
		self._playerManager:GiveSword(player)
		local character = player.Character
		if character == nil then
			continue
		end
		local humanoid = character:FindFirstChildOfClass("Humanoid")
		if humanoid == nil then
			continue
		end
		self.CurrentMaid:GiveTask(humanoid.Died:Connect(function(): ()
			self:CheckWinCondition(nil)
		end))
	end
	self.CurrentMaid:GiveTask(Players.PlayerRemoving:Connect(function(player: Player): ()
		self:CheckWinCondition(player)
	end))
end

function RoundManager.CheckWinCondition(self: RoundManager, excludePlayer: Player?): ()
	local aliveCount = 0
	local lastAlive: Player? = nil
	for player in pairs(self.Participants) do
		if player == excludePlayer then
			continue
		end
		if player.Parent ~= Players then
			continue
		end
		if not self._playerManager:IsPlayerAlive(player) then
			continue
		end
		aliveCount += 1
		lastAlive = player
	end
	if aliveCount <= 1 then
		self.Winner = lastAlive
		self.RoundEnded:Fire()
	end
end

function RoundManager.StartCleanup(self: RoundManager): ()
	local winner = self.Winner
	if winner ~= nil and winner.Parent == Players then
		self._dataManager:AddWins(winner, GameConfig.WIN_AMOUNT)
		self._dataManager:AddCoins(winner, GameConfig.WIN_COINS)
	end
	for _, player in Players:GetPlayers() do
		self._playerManager:ClearSwords(player)
		local character = player.Character
		if character == nil then
			player:LoadCharacter()
		else
			local humanoid = character:FindFirstChildOfClass("Humanoid")
			if humanoid == nil or humanoid.Health <= 0 then
				player:LoadCharacter()
			end
		end
	end
	task.wait(0.5)
	local lobby = self:_findLobby()
	if lobby == nil then
		return
	end
	self._playerManager:TeleportPlayersTo(Players:GetPlayers(), lobby)
end

function RoundManager.Destroy(self: RoundManager): ()
	self.CurrentMaid:DoCleaning()
	self._playerManager:Destroy()
	self._dataManager:Destroy()
end

return RoundManager`,

        'RoundManagerSingleton.lua': `--!strict
local RoundManager = require(script.Parent.RoundManager)

export type RoundManager = RoundManager.RoundManager

local instance: RoundManager = RoundManager.new()

return instance`,

        'ServerSwordHandler.lua': `--!strict
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Players = game:GetService("Players")

local Maid = require(ReplicatedStorage.SharedModules.Maid)
local GameConfig = require(ReplicatedStorage.SharedModules.GameConfig)
local RoundManagerSingleton = require(script.Parent.RoundManagerSingleton)

local SWORD_TOOL_NAME = "ClassicSword"

local function getOrCreateFolder(parent: Instance, name: string): Folder
	local existing = parent:FindFirstChild(name)
	if existing ~= nil and existing:IsA("Folder") then
		return existing
	end
	local folder = Instance.new("Folder")
	folder.Name = name
	folder.Parent = parent
	return folder
end

local function getOrCreateRemoteEvent(parent: Instance, name: string): RemoteEvent
	local existing = parent:FindFirstChild(name)
	if existing ~= nil and existing:IsA("RemoteEvent") then
		return existing
	end
	local event = Instance.new("RemoteEvent")
	event.Name = name
	event.Parent = parent
	return event
end

local Events: Folder = getOrCreateFolder(ReplicatedStorage, "Events")
local SwordHitEvent: RemoteEvent = getOrCreateRemoteEvent(Events, "SwordHitEvent")

local ServerSwordHandler = {}

local started: boolean = false
local handlerMaid: Maid.Maid? = nil
local debounceTable: { [Player]: number } = {}

local function getEquippedSword(player: Player): Tool?
	local character = player.Character
	if character == nil then
		return nil
	end
	local tool = character:FindFirstChildOfClass("Tool")
	if tool ~= nil and tool.Name == SWORD_TOOL_NAME then
		return tool
	end
	return nil
end

local function resolveRoot(character: Model): BasePart?
	local root = character:FindFirstChild("HumanoidRootPart")
	if root ~= nil and root:IsA("BasePart") then
		return root
	end
	return nil
end

local function onSwordHit(player: Player): ()
	if RoundManagerSingleton:GetCurrentState() ~= "InGame" then
		return
	end
	if not RoundManagerSingleton:IsParticipant(player) then
		return
	end
	local now = os.clock()
	local last = debounceTable[player]
	if last ~= nil and now - last < GameConfig.SWORD_DEBOUNCE then
		return
	end
	local attackerCharacter = player.Character
	if attackerCharacter == nil then
		return
	end
	local attackerRoot = resolveRoot(attackerCharacter)
	if attackerRoot == nil then
		return
	end
	if getEquippedSword(player) == nil then
		return
	end
	local params = RaycastParams.new()
	params.FilterDescendantsInstances = { attackerCharacter }
	params.FilterType = Enum.RaycastFilterType.Exclude
	local origin = attackerRoot.Position
	local direction = attackerRoot.CFrame.LookVector * GameConfig.SPHERECAST_RANGE
	local result = workspace:Spherecast(origin, GameConfig.SPHERECAST_RADIUS, direction, params)
	if result == nil then
		return
	end
	local hitPart = result.Instance
	if hitPart == nil then
		return
	end
	local rawAncestor = hitPart:FindFirstAncestorOfClass("Model")
	if rawAncestor == nil then
		return
	end
	local targetCharacter: Model = rawAncestor :: Model
	if targetCharacter == attackerCharacter then
		return
	end
	local targetHumanoid = targetCharacter:FindFirstChildOfClass("Humanoid")
	if targetHumanoid == nil or targetHumanoid.Health <= 0 then
		return
	end
	local targetRoot = resolveRoot(targetCharacter)
	if targetRoot == nil then
		return
	end
	local distance = (attackerRoot.Position - targetRoot.Position).Magnitude
	if distance > GameConfig.MAX_DAMAGE_DISTANCE then
		return
	end
	local targetPlayer = Players:GetPlayerFromCharacter(targetCharacter)
	if targetPlayer == nil then
		return
	end
	if not RoundManagerSingleton:IsParticipant(targetPlayer) then
		return
	end
	debounceTable[player] = now
	targetHumanoid:TakeDamage(GameConfig.SWORD_DAMAGE)
end

function ServerSwordHandler.Start(): ()
	if started then
		return
	end
	started = true
	local newMaid = Maid.new()
	handlerMaid = newMaid
	newMaid:GiveTask(SwordHitEvent.OnServerEvent:Connect(function(player: Player, ...: any): ()
		onSwordHit(player)
	end))
	newMaid:GiveTask(Players.PlayerRemoving:Connect(function(player: Player): ()
		debounceTable[player] = nil
	end))
end

function ServerSwordHandler.Stop(): ()
	if not started then
		return
	end
	started = false
	local existing = handlerMaid
	if existing ~= nil then
		existing:DoCleaning()
		handlerMaid = nil
	end
	table.clear(debounceTable)
end

return ServerSwordHandler`,

        'TimerService.lua': `--!strict
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Players = game:GetService("Players")

local Maid = require(ReplicatedStorage.SharedModules.Maid)

local function getOrCreateFolder(parent: Instance, name: string): Folder
	local existing = parent:FindFirstChild(name)
	if existing ~= nil and existing:IsA("Folder") then
		return existing
	end
	local folder = Instance.new("Folder")
	folder.Name = name
	folder.Parent = parent
	return folder
end

local function getOrCreateRemoteEvent(parent: Instance, name: string): RemoteEvent
	local existing = parent:FindFirstChild(name)
	if existing ~= nil and existing:IsA("RemoteEvent") then
		return existing
	end
	local event = Instance.new("RemoteEvent")
	event.Name = name
	event.Parent = parent
	return event
end

local Events: Folder = getOrCreateFolder(ReplicatedStorage, "Events")
local TimeSyncEvent: RemoteEvent = getOrCreateRemoteEvent(Events, "TimeSyncEvent")

local currentEndTime: number = 0
local moduleMaid = Maid.new()

local TimerService = {}

function TimerService.StartTimer(durationInSeconds: number): number
	local endTime = workspace:GetServerTimeNow() + durationInSeconds
	currentEndTime = endTime
	TimeSyncEvent:FireAllClients(endTime)
	return endTime
end

function TimerService.GetCurrentEndTime(): number
	return currentEndTime
end

moduleMaid:GiveTask(Players.PlayerAdded:Connect(function(player: Player): ()
	if currentEndTime > workspace:GetServerTimeNow() then
		TimeSyncEvent:FireClient(player, currentEndTime)
	end
end))

return TimerService`
      }
    },

    plot: {
      name: 'Basic Plot System',
      files: {
        'PlotClaimSystem.lua': `--!strict

local Players = game:GetService("Players")
local Workspace = game:GetService("Workspace")

local PLOTS_FOLDER: string = "Plots"
local CLAIM_PAD_NAME: string = "ClaimPad"
local SIGN_NAME: string = "Sign"
local UNCLAIMED_TEXT: string = "Unclaimed Brainrot Base"
local CLAIMED_TEXT_FORMAT: string = "%s's Brainrot Base"
local UNCLAIMED_COLOR: Color3 = Color3.fromRGB(0, 255, 0)
local CLAIMED_COLOR: Color3 = Color3.fromRGB(255, 0, 0)
local DEBOUNCE_TIME: number = 0.5

local playerDebounce: {[Player]: number?} = {}

local function findPlotByOwner(ownerName: string): Model?
	local plotsFolder = Workspace:FindFirstChild(PLOTS_FOLDER)
	if not plotsFolder then
		return nil
	end
	for _, child in plotsFolder:GetChildren() do
		if child:IsA("Model") then
			local owner = child:GetAttribute("Owner") :: string
			if owner == ownerName then
				return child
			end
		end
	end
	return nil
end

local function playerOwnsPlot(playerName: string): boolean
	return findPlotByOwner(playerName) ~= nil
end

local function updatePlotVisuals(plot: Model, isClaimed: boolean, ownerName: string): ()
	local rawPad = plot:FindFirstChild(CLAIM_PAD_NAME)
	if rawPad and rawPad:IsA("BasePart") then
		local pad = rawPad :: BasePart
		pad.Color = if isClaimed then CLAIMED_COLOR else UNCLAIMED_COLOR
	end

	local rawSign = plot:FindFirstChild(SIGN_NAME)
	if rawSign and rawSign:IsA("BasePart") then
		local rawGui = rawSign:FindFirstChild("SurfaceGui")
		if rawGui then
			local rawLabel = rawGui:FindFirstChild("TextLabel")
			if rawLabel and rawLabel:IsA("TextLabel") then
				local label = rawLabel :: TextLabel
				label.Text = if isClaimed
					then string.format(CLAIMED_TEXT_FORMAT, ownerName)
					else UNCLAIMED_TEXT
			end
		end
	end
end

local function claimPlot(plot: Model, player: Player): ()
	plot:SetAttribute("Owner", player.Name)
	updatePlotVisuals(plot, true, player.Name)
	playerDebounce[player] = os.clock()
end

local function releasePlot(plot: Model): ()
	plot:SetAttribute("Owner", "")
	updatePlotVisuals(plot, false, "")
end

local function onPlayerRemoving(player: Player): ()
	local ownedPlot = findPlotByOwner(player.Name)
	if ownedPlot then
		releasePlot(ownedPlot)
	end
	playerDebounce[player] = nil
end

local function initializePlots(): ()
	local plotsFolder = Workspace:FindFirstChild(PLOTS_FOLDER)
	if not plotsFolder then
		warn("Plots folder not found in Workspace!")
		return
	end

	for _, child in plotsFolder:GetChildren() do
		if not child:IsA("Model") then
			continue
		end
		local plot = child :: Model

		plot:SetAttribute("Owner", "")
		updatePlotVisuals(plot, false, "")

		local rawPad = plot:FindFirstChild(CLAIM_PAD_NAME)
		if not rawPad or not rawPad:IsA("BasePart") then
			warn("ClaimPad not found in plot: " .. plot.Name)
			continue
		end
		local pad = rawPad :: BasePart

		pad.Touched:Connect(function(otherPart: BasePart): ()
			local parent = otherPart.Parent
			if not parent or not parent:IsA("Model") then
				return
			end
			local character = parent :: Model

			if not character:FindFirstChildOfClass("Humanoid") then
				return
			end

			local player = Players:GetPlayerFromCharacter(character)
			if not player then
				return
			end

			local lastTouch: number = playerDebounce[player] or 0
			if os.clock() - lastTouch < DEBOUNCE_TIME then
				return
			end

			local currentOwner = plot:GetAttribute("Owner") :: string
			if currentOwner ~= "" then
				return
			end

			if playerOwnsPlot(player.Name) then
				return
			end

			claimPlot(plot, player)
		end)
	end
end

Players.PlayerRemoving:Connect(onPlayerRemoving)
initializePlots()`
      }
    },

    notify: {
      name: 'Simple Notification System',
      files: {
        'ImportantNotificationBootstrap.lua': `--!strict
local ReplicatedStorage: ReplicatedStorage = game:GetService("ReplicatedStorage")

local existing: Instance? = ReplicatedStorage:FindFirstChild("ImportantNotificationEvent")
if existing then
	if existing:IsA("RemoteEvent") then
		return
	end
	existing:Destroy()
end

local remote: RemoteEvent = Instance.new("RemoteEvent")
remote.Name = "ImportantNotificationEvent"
remote.Parent = ReplicatedStorage`,

        'NotificationController.lua': `--!strict
local Players: Players = game:GetService("Players")
local ReplicatedStorage: ReplicatedStorage = game:GetService("ReplicatedStorage")
local TweenService: TweenService = game:GetService("TweenService")
local RunService: RunService = game:GetService("RunService")

type NotificationKind = "error" | "success"
type TextObject = TextLabel | TextButton | TextBox
type ImageObject = ImageLabel | ImageButton
type Originals = {
	textTransparency: { [Instance]: number },
	textStrokeTransparency: { [Instance]: number },
	imageTransparency: { [Instance]: number },
	backgroundTransparency: { [Instance]: number },
	strokeTransparency: { [Instance]: number },
}
type Layout = {
	anchorPoint: Vector2,
	position: UDim2,
	size: UDim2,
	rotation: number,
}
type QueueItem = {
	kind: NotificationKind,
	text: string,
}
type CancelHandler = () -> ()

local player: Player = Players.LocalPlayer

local screenGui: Instance? = script:FindFirstAncestorOfClass("ScreenGui")
if not screenGui then
	return
end

local importantNotificationsRaw: Instance? = script.Parent
if not importantNotificationsRaw or not importantNotificationsRaw:IsA("GuiObject") then
	return
end
local importantNotifications: GuiObject = importantNotificationsRaw :: GuiObject

local notificationsAndPopupsRaw: Instance? = importantNotifications.Parent
if not notificationsAndPopupsRaw or not notificationsAndPopupsRaw:IsA("GuiObject") then
	return
end
local notificationsAndPopups: GuiObject = notificationsAndPopupsRaw :: GuiObject

local noAffordRaw: Instance? = importantNotifications:FindFirstChild("NoAfford")
local successRaw: Instance? = importantNotifications:FindFirstChild("Success")
local eventRaw: Instance? = ReplicatedStorage:FindFirstChild("ImportantNotificationEvent")

if not noAffordRaw or not successRaw or not eventRaw then
	return
end
if not noAffordRaw:IsA("GuiObject") or not successRaw:IsA("GuiObject") then
	return
end
if not eventRaw:IsA("RemoteEvent") then
	return
end

local noAffordTemplate: GuiObject = noAffordRaw :: GuiObject
local successTemplate: GuiObject = successRaw :: GuiObject
local importantNotificationEvent: RemoteEvent = eventRaw :: RemoteEvent

local function resolveOverlay(): Frame
	local existing: Instance? = notificationsAndPopups:FindFirstChild("ImportantNotificationsOverlay")
	if existing and existing:IsA("Frame") then
		return existing :: Frame
	end
	if existing then
		existing:Destroy()
	end
	local fresh: Frame = Instance.new("Frame")
	fresh.Name = "ImportantNotificationsOverlay"
	fresh.BackgroundTransparency = 1
	fresh.BorderSizePixel = 0
	fresh.Size = UDim2.fromScale(1, 1)
	fresh.Position = UDim2.fromScale(0, 0)
	fresh.ZIndex = 50
	fresh.Parent = notificationsAndPopups
	return fresh
end

local overlay: Frame = resolveOverlay()

local queue: { QueueItem } = {}
local isProcessing: boolean = false
local cancelCurrentNotification: CancelHandler? = nil

local function collectAnimatables(root: Instance): ({ TextObject }, { ImageObject }, { GuiObject }, { UIStroke })
	local texts: { TextObject } = {}
	local images: { ImageObject } = {}
	local backgrounds: { GuiObject } = {}
	local strokes: { UIStroke } = {}

	local function add(instance: Instance): ()
		if instance:IsA("TextLabel") then
			table.insert(texts, instance)
			table.insert(backgrounds, instance)
		elseif instance:IsA("TextButton") then
			table.insert(texts, instance)
			table.insert(backgrounds, instance)
		elseif instance:IsA("TextBox") then
			table.insert(texts, instance)
			table.insert(backgrounds, instance)
		elseif instance:IsA("ImageLabel") then
			table.insert(images, instance)
			table.insert(backgrounds, instance)
		elseif instance:IsA("ImageButton") then
			table.insert(images, instance)
			table.insert(backgrounds, instance)
		elseif instance:IsA("Frame") then
			table.insert(backgrounds, instance)
		elseif instance:IsA("UIStroke") then
			table.insert(strokes, instance)
		end
	end

	add(root)
	for _: number, descendant: Instance in ipairs(root:GetDescendants()) do
		add(descendant)
	end

	return texts, images, backgrounds, strokes
end

local function storeOriginals(
	texts: { TextObject },
	images: { ImageObject },
	backgrounds: { GuiObject },
	strokes: { UIStroke }
): Originals
	local originals: Originals = {
		textTransparency = {},
		textStrokeTransparency = {},
		imageTransparency = {},
		backgroundTransparency = {},
		strokeTransparency = {},
	}

	for _: number, object: TextObject in ipairs(texts) do
		originals.textTransparency[object] = object.TextTransparency
		originals.textStrokeTransparency[object] = object.TextStrokeTransparency
	end

	for _: number, object: ImageObject in ipairs(images) do
		originals.imageTransparency[object] = object.ImageTransparency
	end

	for _: number, object: GuiObject in ipairs(backgrounds) do
		originals.backgroundTransparency[object] = object.BackgroundTransparency
	end

	for _: number, object: UIStroke in ipairs(strokes) do
		originals.strokeTransparency[object] = object.Transparency
	end

	return originals
end

local function setHidden(
	texts: { TextObject },
	images: { ImageObject },
	backgrounds: { GuiObject },
	strokes: { UIStroke }
): ()
	for _: number, object: TextObject in ipairs(texts) do
		object.TextTransparency = 1
		object.TextStrokeTransparency = 1
	end

	for _: number, object: ImageObject in ipairs(images) do
		object.ImageTransparency = 1
	end

	for _: number, object: GuiObject in ipairs(backgrounds) do
		object.BackgroundTransparency = 1
	end

	for _: number, object: UIStroke in ipairs(strokes) do
		object.Transparency = 1
	end
end

local function buildIntroTweens(
	root: GuiObject,
	texts: { TextObject },
	images: { ImageObject },
	backgrounds: { GuiObject },
	strokes: { UIStroke },
	originals: Originals,
	targetPosition: UDim2
): { Tween }
	local tweens: { Tween } = {}
	local info: TweenInfo = TweenInfo.new(0.22, Enum.EasingStyle.Quad, Enum.EasingDirection.Out)

	local rootGoal: { [string]: any } = { Position = targetPosition }
	table.insert(tweens, TweenService:Create(root, info, rootGoal))

	for _: number, object: TextObject in ipairs(texts) do
		local goal: { [string]: any } = {
			TextTransparency = originals.textTransparency[object] or 0,
			TextStrokeTransparency = originals.textStrokeTransparency[object] or 1,
		}
		table.insert(tweens, TweenService:Create(object, info, goal))
	end

	for _: number, object: ImageObject in ipairs(images) do
		local goal: { [string]: any } = {
			ImageTransparency = originals.imageTransparency[object] or 0,
		}
		table.insert(tweens, TweenService:Create(object, info, goal))
	end

	for _: number, object: GuiObject in ipairs(backgrounds) do
		local goal: { [string]: any } = {
			BackgroundTransparency = originals.backgroundTransparency[object] or 1,
		}
		table.insert(tweens, TweenService:Create(object, info, goal))
	end

	for _: number, object: UIStroke in ipairs(strokes) do
		local goal: { [string]: any } = {
			Transparency = originals.strokeTransparency[object] or 0,
		}
		table.insert(tweens, TweenService:Create(object, info, goal))
	end

	return tweens
end

local function buildOutroTweens(
	root: GuiObject,
	texts: { TextObject },
	images: { ImageObject },
	backgrounds: { GuiObject },
	strokes: { UIStroke },
	endPosition: UDim2
): { Tween }
	local tweens: { Tween } = {}
	local info: TweenInfo = TweenInfo.new(0.18, Enum.EasingStyle.Quad, Enum.EasingDirection.In)

	local rootGoal: { [string]: any } = { Position = endPosition }
	table.insert(tweens, TweenService:Create(root, info, rootGoal))

	for _: number, object: TextObject in ipairs(texts) do
		local goal: { [string]: any } = { TextTransparency = 1, TextStrokeTransparency = 1 }
		table.insert(tweens, TweenService:Create(object, info, goal))
	end

	for _: number, object: ImageObject in ipairs(images) do
		local goal: { [string]: any } = { ImageTransparency = 1 }
		table.insert(tweens, TweenService:Create(object, info, goal))
	end

	for _: number, object: GuiObject in ipairs(backgrounds) do
		local goal: { [string]: any } = { BackgroundTransparency = 1 }
		table.insert(tweens, TweenService:Create(object, info, goal))
	end

	for _: number, object: UIStroke in ipairs(strokes) do
		local goal: { [string]: any } = { Transparency = 1 }
		table.insert(tweens, TweenService:Create(object, info, goal))
	end

	return tweens
end

local function getTemplateLayout(template: GuiObject): Layout
	RunService.Heartbeat:Wait()

	local overlayAbsolutePosition: Vector2 = overlay.AbsolutePosition
	local templateAbsolutePosition: Vector2 = template.AbsolutePosition
	local templateAbsoluteSize: Vector2 = template.AbsoluteSize
	local anchor: Vector2 = template.AnchorPoint

	local anchorX: number =
		(templateAbsolutePosition.X - overlayAbsolutePosition.X) + (templateAbsoluteSize.X * anchor.X)
	local anchorY: number =
		(templateAbsolutePosition.Y - overlayAbsolutePosition.Y) + (templateAbsoluteSize.Y * anchor.Y)

	local layout: Layout = {
		anchorPoint = anchor,
		position = UDim2.fromOffset(anchorX, anchorY),
		size = UDim2.fromOffset(templateAbsoluteSize.X, templateAbsoluteSize.Y),
		rotation = template.Rotation,
	}
	return layout
end

local function raiseZIndex(root: Instance, amount: number): ()
	if root:IsA("GuiObject") then
		root.ZIndex += amount
	end
	for _: number, descendant: Instance in ipairs(root:GetDescendants()) do
		if descendant:IsA("GuiObject") then
			descendant.ZIndex += amount
		end
	end
end

local function cancelTweens(tweens: { Tween }): ()
	for _: number, tween: Tween in ipairs(tweens) do
		pcall(function(): ()
			tween:Cancel()
		end)
	end
end

local function applyText(instance: Instance, text: string): ()
	if instance:IsA("TextLabel") then
		instance.Text = text
	elseif instance:IsA("TextButton") then
		instance.Text = text
	elseif instance:IsA("TextBox") then
		instance.Text = text
	end
end

local function displayNotification(kind: NotificationKind, text: string): ()
	local cancelled: boolean = false

	cancelCurrentNotification = function(): ()
		cancelled = true
	end

	local template: GuiObject = if kind == "error" then noAffordTemplate else successTemplate
	local layout: Layout = getTemplateLayout(template)

	if cancelled then
		return
	end

	local notification: GuiObject = (template:Clone() :: any) :: GuiObject
	notification.Name = template.Name .. "_Live"
	notification.Visible = true
	notification.AnchorPoint = layout.anchorPoint
	notification.Position = UDim2.fromOffset(layout.position.X.Offset, layout.position.Y.Offset + 14)
	notification.Size = layout.size
	notification.Rotation = layout.rotation
	notification.Parent = overlay

	raiseZIndex(notification, 100)

	for _: number, descendant: Instance in ipairs(notification:GetDescendants()) do
		applyText(descendant, text)
	end
	applyText(notification, text)

	local texts: { TextObject },
		images: { ImageObject },
		backgrounds: { GuiObject },
		strokes: { UIStroke } =
		collectAnimatables(notification)
	local originals: Originals = storeOriginals(texts, images, backgrounds, strokes)

	setHidden(texts, images, backgrounds, strokes)

	local targetPosition: UDim2 = layout.position
	local endPosition: UDim2 = UDim2.fromOffset(layout.position.X.Offset, layout.position.Y.Offset - 10)

	local introTweens: { Tween } =
		buildIntroTweens(notification, texts, images, backgrounds, strokes, originals, targetPosition)

	for _: number, tween: Tween in ipairs(introTweens) do
		tween:Play()
	end

	if #introTweens > 0 then
		introTweens[1].Completed:Wait()
	end

	if cancelled or not notification.Parent then
		cancelTweens(introTweens)
		pcall(function(): ()
			notification:Destroy()
		end)
		return
	end

	task.wait(0.85)

	if cancelled or not notification.Parent then
		pcall(function(): ()
			notification:Destroy()
		end)
		return
	end

	local outroTweens: { Tween } =
		buildOutroTweens(notification, texts, images, backgrounds, strokes, endPosition)

	for _: number, tween: Tween in ipairs(outroTweens) do
		tween:Play()
	end

	if #outroTweens > 0 then
		outroTweens[1].Completed:Wait()
	end

	if cancelled or not notification.Parent then
		cancelTweens(outroTweens)
		pcall(function(): ()
			notification:Destroy()
		end)
		return
	end

	notification:Destroy()
end

local function processQueue(): ()
	if isProcessing then
		return
	end
	isProcessing = true
	while #queue > 0 do
		local item: QueueItem? = table.remove(queue, 1)
		if item then
			displayNotification(item.kind, item.text)
		end
	end
	isProcessing = false
end

local function resolveKind(value: string): NotificationKind
	if value == "error" then
		return "error"
	end
	return "success"
end

local function enqueue(kind: string, text: string): ()
	local resolved: NotificationKind = resolveKind(kind)
	local item: QueueItem = { kind = resolved, text = text }
	table.insert(queue, item)
	task.spawn(processQueue)
end

local function clearOverlay(): ()
	if cancelCurrentNotification then
		cancelCurrentNotification()
		cancelCurrentNotification = nil
	end
	table.clear(queue)
	isProcessing = false
	for _: number, child: Instance in ipairs(overlay:GetChildren()) do
		child:Destroy()
	end
end

noAffordTemplate.Visible = false
successTemplate.Visible = false

importantNotificationEvent.OnClientEvent:Connect(function(kind: any, text: any): ()
	if type(kind) ~= "string" then
		return
	end

	local kindString: string = kind :: string
	local finalText: string

	if type(text) == "string" and text ~= "" then
		finalText = text :: string
	elseif kindString == "error" then
		finalText = "You can't afford this.."
	else
		finalText = "Successfully Purchased!"
	end

	enqueue(kindString, finalText)
end)

player.CharacterAdded:Connect(function(_character: Model): ()
	clearOverlay()
end)`
      }
    },

    'drag-solo': {
      name: 'Simple Dead Rails Drag System ( no multiplayer )',
      files: {
        'DragClient.lua': `--!strict

local CollectionService = game:GetService("CollectionService")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local RunService = game:GetService("RunService")
local UserInputService = game:GetService("UserInputService")
local Players = game:GetService("Players")

local DRAG_TAG: string = "Draggable"
local HOLD_DISTANCE: number = 8
local MAX_GRAB_DISTANCE: number = 20
local HIGHLIGHT_COLOR: Color3 = Color3.fromRGB(255, 255, 255)
local HIGHLIGHT_SURFACE_COLOR: Color3 = Color3.fromRGB(180, 210, 255)
local HIGHLIGHT_THICKNESS: number = 0.07

local camera: Camera = workspace.CurrentCamera
local localPlayer: Player = Players.LocalPlayer
local character: Model = (localPlayer.Character or localPlayer.CharacterAdded:Wait()) :: Model

local dragAttachment = workspace.Terrain:WaitForChild("DragAttachment") :: Attachment

local remotes = ReplicatedStorage:WaitForChild("Remotes") :: Folder
local eDragStart = remotes:WaitForChild("DragStart") :: RemoteEvent
local eDragEnd = remotes:WaitForChild("DragEnd") :: RemoteEvent

local selectionBox: SelectionBox = Instance.new("SelectionBox")
selectionBox.Color3 = HIGHLIGHT_COLOR
selectionBox.LineThickness = HIGHLIGHT_THICKNESS
selectionBox.SurfaceTransparency = 0.85
selectionBox.SurfaceColor3 = HIGHLIGHT_SURFACE_COLOR
selectionBox.Adornee = nil
selectionBox.Parent = workspace

local rayParams: RaycastParams = RaycastParams.new()
rayParams.FilterType = Enum.RaycastFilterType.Exclude
rayParams.FilterDescendantsInstances = { character :: Instance }

local isDragging: boolean = false
local hoveredPart: BasePart? = nil

local function computeTargetCFrame(): CFrame
	return camera.CFrame * CFrame.new(0, 0, -HOLD_DISTANCE)
end

local function getHoveredPart(): BasePart?
	local origin: Vector3 = camera.CFrame.Position
	local direction: Vector3 = camera.CFrame.LookVector * MAX_GRAB_DISTANCE
	local result: RaycastResult? = workspace:Raycast(origin, direction, rayParams)
	if result == nil then return nil end
	local hit: Instance = result.Instance
	if not hit:IsA("BasePart") then return nil end
	if not CollectionService:HasTag(hit, DRAG_TAG) then return nil end
	return hit :: BasePart
end

local function setHighlight(part: BasePart?): ()
	selectionBox.Adornee = part
end

UserInputService.InputBegan:Connect(function(input: InputObject, gameProcessed: boolean)
	if gameProcessed then return end
	if input.UserInputType ~= Enum.UserInputType.MouseButton1 then return end
	if isDragging then return end
	local target: BasePart? = hoveredPart
	if target == nil then return end
	isDragging = true
	rayParams.FilterDescendantsInstances = { character :: Instance, target :: Instance }
	eDragStart:FireServer(target)
end)

UserInputService.InputEnded:Connect(function(input: InputObject, _gameProcessed: boolean)
	if input.UserInputType ~= Enum.UserInputType.MouseButton1 then return end
	if not isDragging then return end
	isDragging = false
	hoveredPart = nil
	setHighlight(nil)
	rayParams.FilterDescendantsInstances = { character :: Instance }
	eDragEnd:FireServer()
end)

RunService.RenderStepped:Connect(function(_dt: number)
	if isDragging then
		dragAttachment.CFrame = computeTargetCFrame()
		return
	end
	local newHover: BasePart? = getHoveredPart()
	if newHover ~= hoveredPart then
		hoveredPart = newHover
		setHighlight(hoveredPart)
	end
end)`,

        'DragServer.lua': `--!strict

local CollectionService = game:GetService("CollectionService")
local ReplicatedStorage = game:GetService("ReplicatedStorage")

type DragState = {
	part: BasePart,
	partAttachment: Attachment,
	alignPosition: AlignPosition,
	alignOrientation: AlignOrientation,
}

local DRAG_TAG: string = "Draggable"
local MAX_FORCE: number = 100000
local MAX_TORQUE: number = 100000
local RESPONSIVENESS: number = 25
local DRAGGABLE_NAMES: { string } = { "Part1", "Part2", "Part3" }

local dragAttachment: Attachment = Instance.new("Attachment")
dragAttachment.Name = "DragAttachment"
dragAttachment.CFrame = CFrame.identity
dragAttachment.Parent = workspace.Terrain

local remotes = ReplicatedStorage:WaitForChild("Remotes") :: Folder
local eDragStart = remotes:WaitForChild("DragStart") :: RemoteEvent
local eDragEnd = remotes:WaitForChild("DragEnd") :: RemoteEvent

local activeDrags: { [Player]: DragState } = {}

for _, partName in DRAGGABLE_NAMES do
	local found = workspace:FindFirstChild(partName)
	if found ~= nil and found:IsA("BasePart") then
		local part = found :: BasePart
		part.Anchored = false
		CollectionService:AddTag(part, DRAG_TAG)
	end
end

local function buildDragState(part: BasePart): DragState
	local partAtt = Instance.new("Attachment")
	partAtt.Name = "DragPartAttachment"
	partAtt.Position = Vector3.zero
	partAtt.Parent = part

	local ap = Instance.new("AlignPosition")
	ap.Mode = Enum.PositionAlignmentMode.TwoAttachment
	ap.Attachment0 = partAtt
	ap.Attachment1 = dragAttachment
	ap.MaxForce = MAX_FORCE
	ap.MaxVelocity = 200
	ap.Responsiveness = RESPONSIVENESS
	ap.Enabled = true
	ap.Parent = part

	local ao = Instance.new("AlignOrientation")
	ao.Mode = Enum.OrientationAlignmentMode.OneAttachment
	ao.Attachment0 = partAtt
	ao.MaxTorque = MAX_TORQUE
	ao.MaxAngularVelocity = 200
	ao.Responsiveness = RESPONSIVENESS
	ao.CFrame = part.CFrame
	ao.Enabled = true
	ao.Parent = part

	return {
		part = part,
		partAttachment = partAtt,
		alignPosition = ap,
		alignOrientation = ao,
	}
end

local function teardown(state: DragState): ()
	state.alignOrientation:Destroy()
	state.alignPosition:Destroy()
	state.partAttachment:Destroy()
end

eDragStart.OnServerEvent:Connect(function(player: Player, rawPart: any)
	if activeDrags[player] ~= nil then return end
	if typeof(rawPart) ~= "Instance" then return end
	if not rawPart:IsA("BasePart") then return end
	if not CollectionService:HasTag(rawPart, DRAG_TAG) then return end
	local part = rawPart :: BasePart
	part:SetNetworkOwner(player)
	activeDrags[player] = buildDragState(part)
end)

eDragEnd.OnServerEvent:Connect(function(player: Player)
	local state = activeDrags[player]
	if state == nil then return end
	activeDrags[player] = nil
	local part = state.part
	teardown(state)
	part:SetNetworkOwnershipAuto()
end)`,

        'FirstPersonLock.lua': `--!strict

local Players = game:GetService("Players")

local LOCKED_CAMERA_MODE: Enum.CameraMode = Enum.CameraMode.LockFirstPerson

local localPlayer: Player = Players.LocalPlayer

local function enforce(): ()
	if localPlayer.CameraMode ~= LOCKED_CAMERA_MODE then
		localPlayer.CameraMode = LOCKED_CAMERA_MODE
	end
end

enforce()

localPlayer:GetPropertyChangedSignal("CameraMode"):Connect(enforce)`
      }
    },

    'drag-multi': {
      name: 'Dead Rails Drag System ( multiplayer )',
      files: {
        'DragClient.lua': `--!strict

local CollectionService = game:GetService("CollectionService")
local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local RunService = game:GetService("RunService")
local UserInputService = game:GetService("UserInputService")

local DRAG_TAG: string = "Draggable"
local DRAG_OWNER_ATTR: string = "DragOwner"
local DRAG_ATT_PREFIX: string = "DragAtt_"
local HOLD_DISTANCE: number = 8
local MAX_GRAB_DISTANCE: number = 20
local HIGHLIGHT_COLOR: Color3 = Color3.fromRGB(255, 255, 255)
local HIGHLIGHT_SURFACE_COLOR: Color3 = Color3.fromRGB(180, 210, 255)
local HIGHLIGHT_THICKNESS: number = 0.07
local HIGHLIGHT_SURFACE_TRANSPARENCY: number = 0.85

local camera: Camera = workspace.CurrentCamera
local localPlayer: Player = Players.LocalPlayer
local character: Model = (localPlayer.Character or localPlayer.CharacterAdded:Wait()) :: Model

local dragAttName: string = DRAG_ATT_PREFIX .. tostring(localPlayer.UserId)
local dragAttachment = workspace.Terrain:WaitForChild(dragAttName) :: Attachment

local remotes = ReplicatedStorage:WaitForChild("Remotes") :: Folder
local eDragStart = remotes:WaitForChild("DragStart") :: RemoteEvent
local eDragEnd = remotes:WaitForChild("DragEnd") :: RemoteEvent

local selectionBox: SelectionBox = Instance.new("SelectionBox")
selectionBox.Color3 = HIGHLIGHT_COLOR
selectionBox.LineThickness = HIGHLIGHT_THICKNESS
selectionBox.SurfaceTransparency = HIGHLIGHT_SURFACE_TRANSPARENCY
selectionBox.SurfaceColor3 = HIGHLIGHT_SURFACE_COLOR
selectionBox.Adornee = nil
selectionBox.Parent = workspace

local rayParams: RaycastParams = RaycastParams.new()
rayParams.FilterType = Enum.RaycastFilterType.Exclude
rayParams.FilterDescendantsInstances = { character :: Instance }

local isDragging: boolean = false
local hoveredPart: BasePart? = nil

local function computeTargetCFrame(): CFrame
	return camera.CFrame * CFrame.new(0, 0, -HOLD_DISTANCE)
end

local function getHoveredPart(): BasePart?
	local origin: Vector3 = camera.CFrame.Position
	local direction: Vector3 = camera.CFrame.LookVector * MAX_GRAB_DISTANCE
	local result: RaycastResult? = workspace:Raycast(origin, direction, rayParams)
	if result == nil then return nil end
	local hit: Instance = result.Instance
	if not hit:IsA("BasePart") then return nil end
	if not CollectionService:HasTag(hit, DRAG_TAG) then return nil end
	if hit:GetAttribute(DRAG_OWNER_ATTR) ~= nil then return nil end
	return hit :: BasePart
end

local function setHighlight(part: BasePart?): ()
	selectionBox.Adornee = part
end

localPlayer.CharacterAdded:Connect(function(newCharacter: Model)
	character = newCharacter
	rayParams.FilterDescendantsInstances = { newCharacter :: Instance }
	if isDragging then
		isDragging = false
		hoveredPart = nil
		setHighlight(nil)
		eDragEnd:FireServer()
	end
end)

UserInputService.InputBegan:Connect(function(input: InputObject, gameProcessed: boolean)
	if gameProcessed then return end
	if input.UserInputType ~= Enum.UserInputType.MouseButton1 then return end
	if isDragging then return end
	local target: BasePart? = hoveredPart
	if target == nil then return end
	if target:GetAttribute(DRAG_OWNER_ATTR) ~= nil then return end
	isDragging = true
	rayParams.FilterDescendantsInstances = { character :: Instance, target :: Instance }
	eDragStart:FireServer(target)
end)

UserInputService.InputEnded:Connect(function(input: InputObject, _gameProcessed: boolean)
	if input.UserInputType ~= Enum.UserInputType.MouseButton1 then return end
	if not isDragging then return end
	isDragging = false
	hoveredPart = nil
	setHighlight(nil)
	rayParams.FilterDescendantsInstances = { character :: Instance }
	eDragEnd:FireServer()
end)

RunService.RenderStepped:Connect(function(_dt: number)
	if isDragging then
		dragAttachment.CFrame = computeTargetCFrame()
		return
	end
	local newHover: BasePart? = getHoveredPart()
	if newHover ~= hoveredPart then
		hoveredPart = newHover
		setHighlight(hoveredPart)
	end
end)`,

        'DragServer.lua': `--!strict

local CollectionService = game:GetService("CollectionService")
local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local RunService = game:GetService("RunService")

type DragState = {
	owner: Player,
	part: BasePart,
	partAttachment: Attachment,
	alignPosition: AlignPosition,
	alignOrientation: AlignOrientation,
}

local DRAG_TAG: string = "Draggable"
local DRAG_OWNER_ATTR: string = "DragOwner"
local DRAG_ATT_PREFIX: string = "DragAtt_"
local MAX_FORCE: number = 100000
local MAX_TORQUE: number = 100000
local RESPONSIVENESS: number = 25
local MAX_VELOCITY: number = 200
local MAX_ANGULAR_VELOCITY: number = 200
local DRAGGABLE_NAMES: { string } = { "Part1", "Part2", "Part3" }

local remotes = ReplicatedStorage:WaitForChild("Remotes") :: Folder
local eDragStart = remotes:WaitForChild("DragStart") :: RemoteEvent
local eDragEnd = remotes:WaitForChild("DragEnd") :: RemoteEvent

local activeDrags: { [Player]: DragState? } = {}
local playerAttachments: { [Player]: Attachment? } = {}

for _, partName in DRAGGABLE_NAMES do
	local found = workspace:FindFirstChild(partName)
	if found ~= nil and found:IsA("BasePart") then
		local part = found :: BasePart
		part.Anchored = false
		CollectionService:AddTag(part, DRAG_TAG)
	end
end

local function createPlayerAttachment(player: Player): Attachment
	local att = Instance.new("Attachment")
	att.Name = DRAG_ATT_PREFIX .. tostring(player.UserId)
	att.CFrame = CFrame.identity
	att.Parent = workspace.Terrain
	return att
end

local function buildDragState(owner: Player, part: BasePart, dragAtt: Attachment): DragState
	local partAtt = Instance.new("Attachment")
	partAtt.Name = "DragPartAttachment"
	partAtt.Position = Vector3.zero
	partAtt.Parent = part

	local ap = Instance.new("AlignPosition")
	ap.Mode = Enum.PositionAlignmentMode.TwoAttachment
	ap.Attachment0 = partAtt
	ap.Attachment1 = dragAtt
	ap.MaxForce = MAX_FORCE
	ap.MaxVelocity = MAX_VELOCITY
	ap.Responsiveness = RESPONSIVENESS
	ap.Enabled = true
	ap.Parent = part

	local ao = Instance.new("AlignOrientation")
	ao.Mode = Enum.OrientationAlignmentMode.OneAttachment
	ao.Attachment0 = partAtt
	ao.MaxTorque = MAX_TORQUE
	ao.MaxAngularVelocity = MAX_ANGULAR_VELOCITY
	ao.Responsiveness = RESPONSIVENESS
	ao.CFrame = part.CFrame
	ao.Enabled = true
	ao.Parent = part

	return {
		owner = owner,
		part = part,
		partAttachment = partAtt,
		alignPosition = ap,
		alignOrientation = ao,
	}
end

local function teardownDragState(state: DragState): ()
	state.alignOrientation:Destroy()
	state.alignPosition:Destroy()
	state.partAttachment:Destroy()
	state.part:SetAttribute(DRAG_OWNER_ATTR, nil)
	state.part:SetNetworkOwnershipAuto()
end

local function dropPlayerDrag(player: Player): ()
	local state: DragState? = activeDrags[player]
	if state == nil then return end
	activeDrags[player] = nil
	teardownDragState(state)
end

local function onPlayerAdded(player: Player): ()
	playerAttachments[player] = createPlayerAttachment(player)
	player.CharacterRemoving:Connect(function()
		dropPlayerDrag(player)
	end)
end

local function onPlayerRemoving(player: Player): ()
	dropPlayerDrag(player)
	local att: Attachment? = playerAttachments[player]
	if att ~= nil then
		att:Destroy()
		playerAttachments[player] = nil
	end
end

for _, player in pairs(Players:GetPlayers()) do
	onPlayerAdded(player)
end

Players.PlayerAdded:Connect(onPlayerAdded)
Players.PlayerRemoving:Connect(onPlayerRemoving)

eDragStart.OnServerEvent:Connect(function(player: Player, rawPart: any)
	if activeDrags[player] ~= nil then return end
	if typeof(rawPart) ~= "Instance" then return end
	if not rawPart:IsA("BasePart") then return end
	if not CollectionService:HasTag(rawPart, DRAG_TAG) then return end
	if rawPart:GetAttribute(DRAG_OWNER_ATTR) ~= nil then return end

	local dragAtt: Attachment? = playerAttachments[player]
	if dragAtt == nil then return end

	local part = rawPart :: BasePart
	part:SetAttribute(DRAG_OWNER_ATTR, player.UserId)
	part:SetNetworkOwner(player)
	activeDrags[player] = buildDragState(player, part, dragAtt)
end)

eDragEnd.OnServerEvent:Connect(function(player: Player)
	dropPlayerDrag(player)
end)

RunService.Heartbeat:Connect(function(_dt: number)
	local toRemove: { Player } = {}
	for player, state in pairs(activeDrags) do
		if state == nil then continue end
		local ok: boolean = pcall(function()
			state.part:SetNetworkOwner(player)
		end)
		if not ok then
			pcall(teardownDragState, state)
			table.insert(toRemove, player)
		end
	end
	for _, player in toRemove do
		activeDrags[player] = nil
	end
end)`,

        'FirstPersonLock.lua': `--!strict

local Players = game:GetService("Players")

local LOCKED_CAMERA_MODE: Enum.CameraMode = Enum.CameraMode.LockFirstPerson

local localPlayer: Player = Players.LocalPlayer

local function enforce(): ()
	if localPlayer.CameraMode ~= LOCKED_CAMERA_MODE then
		localPlayer.CameraMode = LOCKED_CAMERA_MODE
	end
end

enforce()

localPlayer:GetPropertyChangedSignal("CameraMode"):Connect(enforce)`
      }
    },

    'drag-throw': {
      name: 'Dead Rails Drag System + Throw and Weight ( multiplayer )',
      files: {
        'DragClient.lua': `--!strict

local CollectionService = game:GetService("CollectionService")
local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local RunService = game:GetService("RunService")
local UserInputService = game:GetService("UserInputService")

local Config = require(ReplicatedStorage.GameConfig)

type ThrowSample = {
	time: number,
	position: Vector3,
}

local camera: Camera = workspace.CurrentCamera
local localPlayer: Player = Players.LocalPlayer
local character: Model = (localPlayer.Character or localPlayer.CharacterAdded:Wait()) :: Model

local dragAttName: string = Config.AttachmentPrefix .. tostring(localPlayer.UserId)
local dragAttachment = workspace.Terrain:WaitForChild(dragAttName) :: Attachment

local remotes = ReplicatedStorage:WaitForChild("Remotes") :: Folder
local eDragStart = remotes:WaitForChild("DragStart") :: RemoteEvent
local eDragEnd = remotes:WaitForChild("DragEnd") :: RemoteEvent

local selectionBox: SelectionBox = Instance.new("SelectionBox")
selectionBox.Color3 = Config.LightWeightColor
selectionBox.LineThickness = Config.HighlightThickness
selectionBox.SurfaceTransparency = Config.HighlightSurfaceTransparency
selectionBox.SurfaceColor3 = Config.HighlightSurfaceColor
selectionBox.Adornee = nil
selectionBox.Parent = workspace

local rayParams: RaycastParams = RaycastParams.new()
rayParams.FilterType = Enum.RaycastFilterType.Exclude
rayParams.FilterDescendantsInstances = { character :: Instance }

local isDragging: boolean = false
local hoveredPart: BasePart? = nil
local throwSamples: { ThrowSample } = {}

local function computeTargetCFrame(): CFrame
	return camera.CFrame * CFrame.new(0, 0, -Config.HoldDistance)
end

local function getHoveredPart(): BasePart?
	local origin: Vector3 = camera.CFrame.Position
	local direction: Vector3 = camera.CFrame.LookVector * Config.MaxGrabDistance
	local result: RaycastResult? = workspace:Raycast(origin, direction, rayParams)
	if result == nil then return nil end
	local hit: Instance = result.Instance
	if not hit:IsA("BasePart") then return nil end
	if not CollectionService:HasTag(hit, Config.Tag) then return nil end
	if hit:GetAttribute(Config.OwnerAttribute) ~= nil then return nil end
	return hit :: BasePart
end

local function setHighlight(part: BasePart?): ()
	selectionBox.Adornee = part
	if part ~= nil then
		selectionBox.Color3 = Config.ColorForWeight(Config.GetWeight(part))
	end
end

local function sampleThrow(now: number): ()
	local sample: ThrowSample = { time = now, position = dragAttachment.WorldPosition }
	table.insert(throwSamples, sample)
	while #throwSamples > 0 do
		local first: ThrowSample? = throwSamples[1]
		if first == nil or (now - first.time) <= Config.ThrowSampleTime then break end
		table.remove(throwSamples, 1)
	end
end

local function consumeThrowVelocity(): Vector3?
	if #throwSamples < 2 then
		throwSamples = {}
		return nil
	end
	local oldest: ThrowSample? = throwSamples[1]
	local newest: ThrowSample? = throwSamples[#throwSamples]
	throwSamples = {}
	if oldest == nil or newest == nil then return nil end
	local dt: number = newest.time - oldest.time
	if dt <= 0 then return nil end
	return (newest.position - oldest.position) / dt
end

localPlayer.CharacterAdded:Connect(function(newCharacter: Model)
	character = newCharacter
	rayParams.FilterDescendantsInstances = { newCharacter :: Instance }
	if isDragging then
		isDragging = false
		hoveredPart = nil
		setHighlight(nil)
		throwSamples = {}
		eDragEnd:FireServer(nil)
	end
end)

UserInputService.InputBegan:Connect(function(input: InputObject, gameProcessed: boolean)
	if gameProcessed then return end
	if input.UserInputType ~= Enum.UserInputType.MouseButton1 then return end
	if isDragging then return end
	local target: BasePart? = hoveredPart
	if target == nil then return end
	if target:GetAttribute(Config.OwnerAttribute) ~= nil then return end
	isDragging = true
	throwSamples = {}
	rayParams.FilterDescendantsInstances = { character :: Instance, target :: Instance }
	eDragStart:FireServer(target)
end)

UserInputService.InputEnded:Connect(function(input: InputObject, _gameProcessed: boolean)
	if input.UserInputType ~= Enum.UserInputType.MouseButton1 then return end
	if not isDragging then return end
	isDragging = false
	hoveredPart = nil
	setHighlight(nil)
	rayParams.FilterDescendantsInstances = { character :: Instance }
	local velocity: Vector3? = consumeThrowVelocity()
	eDragEnd:FireServer(velocity)
end)

RunService.RenderStepped:Connect(function(_dt: number)
	if isDragging then
		dragAttachment.CFrame = computeTargetCFrame()
		sampleThrow(tick())
		return
	end
	local newHover: BasePart? = getHoveredPart()
	if newHover ~= hoveredPart then
		hoveredPart = newHover
		setHighlight(hoveredPart)
	end
end)`,

        'DragServer.lua': `--!strict

local CollectionService = game:GetService("CollectionService")
local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local RunService = game:GetService("RunService")

local Config = require(ReplicatedStorage.GameConfig)

type DragState = {
	owner: Player,
	part: BasePart,
	partAttachment: Attachment,
	alignPosition: AlignPosition,
	alignOrientation: AlignOrientation,
}

local remotes = ReplicatedStorage:WaitForChild("Remotes") :: Folder
local eDragStart = remotes:WaitForChild("DragStart") :: RemoteEvent
local eDragEnd = remotes:WaitForChild("DragEnd") :: RemoteEvent

local activeDrags: { [Player]: DragState? } = {}
local playerAttachments: { [Player]: Attachment? } = {}

for _, partName in Config.DraggableNames do
	local found = workspace:FindFirstChild(partName)
	if found ~= nil and found:IsA("BasePart") then
		local part = found :: BasePart
		part.Anchored = false
		CollectionService:AddTag(part, Config.Tag)
		local initialWeight: number? = Config.InitialWeights[partName]
		if initialWeight ~= nil then
			part:SetAttribute(Config.WeightAttribute, initialWeight)
		end
	end
end

local function createPlayerAttachment(player: Player): Attachment
	local att = Instance.new("Attachment")
	att.Name = Config.AttachmentPrefix .. tostring(player.UserId)
	att.CFrame = CFrame.identity
	att.Parent = workspace.Terrain
	return att
end

local function buildDragState(owner: Player, part: BasePart, dragAtt: Attachment): DragState
	local weight: number = Config.GetWeight(part)
	local effResponsiveness: number = Config.BaseResponsiveness / weight
	local effMaxVelocity: number = Config.BaseMaxVelocity / weight
	local effMaxAngularVelocity: number = Config.BaseMaxAngularVelocity / weight

	local partAtt = Instance.new("Attachment")
	partAtt.Name = Config.PartAttachmentName
	partAtt.Position = Vector3.zero
	partAtt.Parent = part

	local ap = Instance.new("AlignPosition")
	ap.Mode = Enum.PositionAlignmentMode.TwoAttachment
	ap.Attachment0 = partAtt
	ap.Attachment1 = dragAtt
	ap.MaxForce = Config.BaseMaxForce
	ap.MaxVelocity = effMaxVelocity
	ap.Responsiveness = effResponsiveness
	ap.Enabled = true
	ap.Parent = part

	local ao = Instance.new("AlignOrientation")
	ao.Mode = Enum.OrientationAlignmentMode.OneAttachment
	ao.Attachment0 = partAtt
	ao.MaxTorque = Config.BaseMaxTorque
	ao.MaxAngularVelocity = effMaxAngularVelocity
	ao.Responsiveness = effResponsiveness
	ao.CFrame = part.CFrame
	ao.Enabled = true
	ao.Parent = part

	return {
		owner = owner,
		part = part,
		partAttachment = partAtt,
		alignPosition = ap,
		alignOrientation = ao,
	}
end

local function teardownConstraints(state: DragState): ()
	state.alignOrientation:Destroy()
	state.alignPosition:Destroy()
	state.partAttachment:Destroy()
	state.part:SetAttribute(Config.OwnerAttribute, nil)
end

local function applyThrow(part: BasePart, velocity: Vector3): ()
	local weight: number = Config.GetWeight(part)
	local scaled: Vector3 = velocity * Config.ThrowMultiplier / math.sqrt(weight)
	if scaled.Magnitude > Config.MaxThrowSpeed then
		scaled = scaled.Unit * Config.MaxThrowSpeed
	end
	part.AssemblyLinearVelocity = scaled
end

local function dropPlayerDrag(player: Player, throwVelocity: Vector3?): ()
	local state: DragState? = activeDrags[player]
	if state == nil then return end
	activeDrags[player] = nil
	local part: BasePart = state.part
	teardownConstraints(state)
	if throwVelocity ~= nil then
		applyThrow(part, throwVelocity)
	end
	part:SetNetworkOwnershipAuto()
end

local function onPlayerAdded(player: Player): ()
	playerAttachments[player] = createPlayerAttachment(player)
	player.CharacterRemoving:Connect(function()
		dropPlayerDrag(player, nil)
	end)
end

local function onPlayerRemoving(player: Player): ()
	dropPlayerDrag(player, nil)
	local att: Attachment? = playerAttachments[player]
	if att ~= nil then
		att:Destroy()
		playerAttachments[player] = nil
	end
end

for _, player in pairs(Players:GetPlayers()) do
	onPlayerAdded(player)
end

Players.PlayerAdded:Connect(onPlayerAdded)
Players.PlayerRemoving:Connect(onPlayerRemoving)

eDragStart.OnServerEvent:Connect(function(player: Player, rawPart: any)
	if activeDrags[player] ~= nil then return end
	if typeof(rawPart) ~= "Instance" then return end
	if not rawPart:IsA("BasePart") then return end
	if not CollectionService:HasTag(rawPart, Config.Tag) then return end
	if rawPart:GetAttribute(Config.OwnerAttribute) ~= nil then return end

	local dragAtt: Attachment? = playerAttachments[player]
	if dragAtt == nil then return end

	local part = rawPart :: BasePart
	part:SetAttribute(Config.OwnerAttribute, player.UserId)
	part:SetNetworkOwner(player)
	activeDrags[player] = buildDragState(player, part, dragAtt)
end)

eDragEnd.OnServerEvent:Connect(function(player: Player, rawVelocity: any)
	local velocity: Vector3? = nil
	if typeof(rawVelocity) == "Vector3" then
		velocity = rawVelocity :: Vector3
	end
	dropPlayerDrag(player, velocity)
end)

RunService.Heartbeat:Connect(function(_dt: number)
	local toRemove: { Player } = {}
	for player, state in pairs(activeDrags) do
		if state == nil then continue end
		local ok: boolean = pcall(function()
			state.part:SetNetworkOwner(player)
		end)
		if not ok then
			pcall(teardownConstraints, state)
			table.insert(toRemove, player)
		end
	end
	for _, player in toRemove do
		activeDrags[player] = nil
	end
end)`,

        'FirstPersonLock.lua': `--!strict

local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")

local Config = require(ReplicatedStorage.GameConfig)

local localPlayer: Player = Players.LocalPlayer

local function enforce(): ()
	if localPlayer.CameraMode ~= Config.CameraMode then
		localPlayer.CameraMode = Config.CameraMode
	end
end

enforce()

localPlayer:GetPropertyChangedSignal("CameraMode"):Connect(enforce)`,

        'GameConfig.lua': `--!strict

local Config = {}

Config.Tag = "Draggable"
Config.OwnerAttribute = "DragOwner"
Config.AttachmentPrefix = "DragAtt_"
Config.PartAttachmentName = "DragPartAttachment"

Config.HoldDistance = 8
Config.MaxGrabDistance = 20

Config.BaseMaxForce = 100000
Config.BaseMaxTorque = 100000
Config.BaseResponsiveness = 25
Config.BaseMaxVelocity = 200
Config.BaseMaxAngularVelocity = 200

Config.WeightAttribute = "Weight"
Config.DefaultWeight = 1
Config.MinWeight = 0.5
Config.MaxWeight = 10

Config.ThrowMultiplier = 2.5
Config.ThrowSampleTime = 0.15
Config.MaxThrowSpeed = 300

Config.HighlightThickness = 0.07
Config.HighlightSurfaceTransparency = 0.85
Config.HighlightSurfaceColor = Color3.fromRGB(180, 210, 255)
Config.LightWeightColor = Color3.fromRGB(150, 255, 150)
Config.HeavyWeightColor = Color3.fromRGB(255, 130, 130)

Config.CameraMode = Enum.CameraMode.LockFirstPerson

Config.DraggableNames = { "Part1", "Part2", "Part3" } :: { string }
Config.InitialWeights = { Part1 = 1, Part2 = 3, Part3 = 8 } :: { [string]: number }

function Config.GetWeight(part: BasePart): number
	local raw = part:GetAttribute(Config.WeightAttribute)
	local value: number = tonumber(raw) or Config.DefaultWeight
	return math.clamp(value, Config.MinWeight, Config.MaxWeight)
end

function Config.ColorForWeight(weight: number): Color3
	local range: number = Config.MaxWeight - Config.MinWeight
	local t: number = if range > 0 then math.clamp((weight - Config.MinWeight) / range, 0, 1) else 0
	return Config.LightWeightColor:Lerp(Config.HeavyWeightColor, t)
end

return Config`
      }
    }
  };

  function initNav() {
    const nav     = $('#nav');
    const links   = $$('.nav__link');
    const targets = $$('section[id]');
    const OFFSET  = 140;

    const onScroll = () => {
      nav.classList.toggle('scrolled', window.scrollY > 28);

      let current = '';
      for (const sec of targets) {
        if (window.scrollY >= sec.offsetTop - OFFSET) current = sec.id;
      }

      for (const link of links) {
        const isActive = link.getAttribute('href') === '#' + current;
        link.classList.toggle('active', isActive);
      }
    };

    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
  }

  function initScrollReveal() {
    const items  = $$('.reveal');
    const groups = $$('.skills__grid, .cards-grid, .hero__content, .contact__inner, .about__panels');

    groups.forEach(grid => {
      const kids = $$('.reveal', grid);
      const slow = grid.classList.contains('hero__content') || grid.classList.contains('contact__inner');
      const step = slow ? 120 : 90;
      kids.forEach((el, i) => {
        el.style.transitionDelay = `${i * step}ms`;
      });
    });

    const io = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.add('visible');
        io.unobserve(entry.target);
      }
    }, { threshold: 0.08, rootMargin: '0px 0px -50px 0px' });

    items.forEach(el => io.observe(el));
  }

  function initSkillFilter() {
    const tags  = $$('.filter-tag');
    const cards = $$('.skill-card');
    if (!tags.length) return;

    tags.forEach(tag => {
      tag.addEventListener('click', () => {
        const want = tag.dataset.filter;

        for (const t of tags) {
          const on = t === tag;
          t.classList.toggle('active', on);
          t.setAttribute('aria-pressed', on ? 'true' : 'false');
        }

        for (let i = 0; i < cards.length; i++) {
          const card = cards[i];
          const ok = want === 'all' || card.dataset.category === want;
          card.classList.toggle('hidden', !ok);
        }
      });
    });
  }

  function initHeroBadges() {
    const badges = $$('.hero__badges .badge');
    if (!badges.length) return;

    badges.forEach((b, i) => {
      b.style.setProperty('--badge-delay', `${300 + i * 120}ms`);
      b.classList.add('badge--hidden');
    });

    requestAnimationFrame(() => requestAnimationFrame(() => {
      badges.forEach(b => b.classList.remove('badge--hidden'));
    }));
  }

  function initCodePreview() {
    const overlay  = $('#codeModalOverlay');
    const titleEl  = $('#codeModalTitle');
    const closeBtn = $('#codeModalClose');
    const sidebar  = $('#codeModalSidebar');
    const panel    = $('#codeModalCodePanel');

    if (!overlay || !panel) return;

    const KW = new Set([
      'and','break','do','else','elseif','end','false','for','function',
      'if','in','local','nil','not','or','repeat','return','then','true',
      'until','while','export','type','continue','goto'
    ]);

    function esc(s) {
      return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    function processLine(line) {
      let out = '';
      let i = 0;
      const n = line.length;

      while (i < n) {
        if (line[i] === '-' && line[i+1] === '-' && line[i+2] === '[' && line[i+3] === '[') {
          const end = line.indexOf(']]', i + 4);
          if (end !== -1) {
            out += '<span class="cmt">' + esc(line.slice(i, end + 2)) + '</span>';
            i = end + 2;
          } else {
            out += '<span class="cmt">' + esc(line.slice(i)) + '</span>';
            return { html: out, ns: 'bc' };
          }
        } else if (line[i] === '-' && line[i+1] === '-') {
          out += '<span class="cmt">' + esc(line.slice(i)) + '</span>';
          return { html: out, ns: 'normal' };
        } else if (line[i] === '[' && line[i+1] === '[') {
          const end = line.indexOf(']]', i + 2);
          if (end !== -1) {
            out += '<span class="str">' + esc(line.slice(i, end + 2)) + '</span>';
            i = end + 2;
          } else {
            out += '<span class="str">' + esc(line.slice(i)) + '</span>';
            return { html: out, ns: 'bs' };
          }
        } else if (line[i] === '"' || line[i] === "'") {
          const q = line[i];
          let j = i + 1;
          while (j < n && line[j] !== q) {
            if (line[j] === '\\') j++;
            j++;
          }
          if (j < n) j++;
          out += '<span class="str">' + esc(line.slice(i, j)) + '</span>';
          i = j;
        } else if (/[0-9]/.test(line[i])) {
          let j = i;
          while (j < n && /[0-9a-fA-FxXeE._]/.test(line[j])) j++;
          out += '<span class="num">' + esc(line.slice(i, j)) + '</span>';
          i = j;
        } else if (/[a-zA-Z_]/.test(line[i])) {
          let j = i;
          while (j < n && /[a-zA-Z0-9_]/.test(line[j])) j++;
          const w = line.slice(i, j);
          out += KW.has(w) ? '<span class="kw">' + esc(w) + '</span>' : esc(w);
          i = j;
        } else {
          out += esc(line[i]);
          i++;
        }
      }

      return { html: out, ns: 'normal' };
    }

    function highlight(source) {
      const rows  = source.split('\n');
      const out   = [];
      let state   = 'normal';

      for (const raw of rows) {
        if (state === 'bc') {
          const e = raw.indexOf(']]');
          if (e !== -1) {
            const { html: rest, ns } = processLine(raw.slice(e + 2));
            out.push('<span class="cmt">' + esc(raw.slice(0, e + 2)) + '</span>' + rest);
            state = ns;
          } else {
            out.push('<span class="cmt">' + esc(raw) + '</span>');
          }
        } else if (state === 'bs') {
          const e = raw.indexOf(']]');
          if (e !== -1) {
            const { html: rest, ns } = processLine(raw.slice(e + 2));
            out.push('<span class="str">' + esc(raw.slice(0, e + 2)) + '</span>' + rest);
            state = ns;
          } else {
            out.push('<span class="str">' + esc(raw) + '</span>');
          }
        } else {
          const { html, ns } = processLine(raw);
          out.push(html);
          state = ns;
        }
      }

      return out;
    }

    function renderFile(source) {
      const lines = highlight(source);
      let html = '<div class="code-table">';
      for (let i = 0; i < lines.length; i++) {
        html += '<div class="code-row">'
          + '<span class="code-num">' + (i + 1) + '</span>'
          + '<span class="code-text">' + lines[i] + '</span>'
          + '</div>';
      }
      html += '</div>';
      panel.innerHTML = html;
      panel.scrollTop = 0;
    }

    function openModal(key) {
      const proj = projectFiles[key];
      if (!proj) return;

      const names = Object.keys(proj.files);
      titleEl.textContent = proj.name;

      sidebar.innerHTML = '';
      names.forEach((name, idx) => {
        const item = document.createElement('div');
        item.className = 'code-modal__file-item' + (idx === 0 ? ' active' : '');
        item.textContent = name;
        item.addEventListener('click', () => {
          $$('.code-modal__file-item').forEach(el => el.classList.remove('active'));
          item.classList.add('active');
          renderFile(proj.files[name]);
        });
        sidebar.appendChild(item);
      });

      renderFile(proj.files[names[0]]);
      overlay.classList.add('open');
      overlay.setAttribute('aria-hidden', 'false');
      document.body.style.overflow = 'hidden';
    }

    function closeModal() {
      overlay.classList.remove('open');
      overlay.setAttribute('aria-hidden', 'true');
      document.body.style.overflow = '';
    }

    $$('.preview-btn').forEach(btn => {
      btn.addEventListener('click', () => openModal(btn.dataset.project));
    });

    closeBtn.addEventListener('click', closeModal);

    overlay.addEventListener('click', e => {
      if (e.target === overlay) closeModal();
    });

    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && overlay.classList.contains('open')) closeModal();
    });
  }

  initNav();
  initScrollReveal();
  initSkillFilter();
  initHeroBadges();
  initCodePreview();
})();
