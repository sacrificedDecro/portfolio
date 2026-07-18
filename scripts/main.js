(function () {
  'use strict';

  const $  = (sel, ctx) => (ctx || document).querySelector(sel);
  const $$ = (sel, ctx) => Array.from((ctx || document).querySelectorAll(sel));

  const projectFiles = {
    inventory: {
      name: 'Custom inventory slot + custom interact system',
      files: {
        'InventoryServer.lua': `--!strict
local Players = game:GetService("Players")
local DataStoreService = game:GetService("DataStoreService")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local ServerStorage = game:GetService("ServerStorage")
local CollectionService = game:GetService("CollectionService")

local SERVER_DISTANCE_TOLERANCE = 5
local PICKUP_COOLDOWN_SECONDS = 0.1

local configModule: ModuleScript = ReplicatedStorage:WaitForChild("GameConfig") :: ModuleScript
local GameConfig = require(configModule)

local dataStore: GlobalDataStore = DataStoreService:GetDataStore(GameConfig.DATASTORE_NAME)

local mastersFolder: Folder = Instance.new("Folder")
mastersFolder.Name = "ItemMasters"
mastersFolder.Parent = ServerStorage

local remoteFolder: Folder = Instance.new("Folder")
remoteFolder.Name = "InventoryRemotes"
remoteFolder.Parent = ReplicatedStorage

local equipEvent: RemoteEvent = Instance.new("RemoteEvent")
equipEvent.Name = "EquipEvent"
equipEvent.Parent = remoteFolder

local dropEvent: RemoteEvent = Instance.new("RemoteEvent")
dropEvent.Name = "DropEvent"
dropEvent.Parent = remoteFolder

local syncEvent: RemoteEvent = Instance.new("RemoteEvent")
syncEvent.Name = "SyncInventory"
syncEvent.Parent = remoteFolder

local equippedSync: RemoteEvent = Instance.new("RemoteEvent")
equippedSync.Name = "EquippedSync"
equippedSync.Parent = remoteFolder

local pickupEvent: RemoteEvent = Instance.new("RemoteEvent")
pickupEvent.Name = "PickupEvent"
pickupEvent.Parent = remoteFolder

type Inventory = { [number]: string? }

local playerCache: { [Player]: Inventory? } = {}
local playerEquipped: { [Player]: number? } = {}
local saveLock: { [number]: boolean } = {}
local activeSaves: number = 0
local itemMasters: { [string]: Instance } = {}
local validItems: { [string]: boolean } = {}
local pickupCooldown: { [Player]: number } = {}

local function createEmptyInventory(): Inventory
	local inv: Inventory = {}
	return inv
end

local function loadData(player: Player): Inventory?
	local userId: number = player.UserId
	local key: string = GameConfig.DATASTORE_KEY_PREFIX .. tostring(userId)
	local success: boolean, result: any = pcall(function(): any
		return dataStore:GetAsync(key)
	end)

	if not success then
		warn(\`[InventoryServer] Load failed for {userId}: {tostring(result)}\`)
		return nil
	end

	local inv: Inventory = createEmptyInventory()
	if type(result) == "table" then
		for i = 1, GameConfig.MAX_SLOTS do
			local val: any = result[tostring(i)] or result[i]
			if type(val) == "string" and validItems[val] then
				inv[i] = val
			end
		end
	end
	return inv
end

local function saveData(player: Player)
	local userId: number = player.UserId
	if saveLock[userId] then return end
	saveLock[userId] = true
	activeSaves += 1

	local inv: Inventory? = playerCache[player]
	if not inv then
		saveLock[userId] = false
		activeSaves -= 1
		return
	end

	local key: string = GameConfig.DATASTORE_KEY_PREFIX .. tostring(userId)
	local saveTable: { [string]: string } = {}
	for i = 1, GameConfig.MAX_SLOTS do
		if inv[i] then
			saveTable[tostring(i)] = inv[i] :: string
		end
	end

	local success: boolean, err: any = pcall(function()
		dataStore:UpdateAsync(key, function(_oldValue: any): any
			return saveTable
		end)
	end)

	if not success then
		warn(\`[InventoryServer] Save failed for {userId}: {tostring(err)}\`)
	end

	saveLock[userId] = false
	activeSaves -= 1
end

local function findFreeSlot(inv: Inventory): number?
	for i = 1, GameConfig.MAX_SLOTS do
		if not inv[i] then
			return i
		end
	end
	return nil
end

local function ownsItem(inv: Inventory, itemName: string): boolean
	for i = 1, GameConfig.MAX_SLOTS do
		if inv[i] == itemName then
			return true
		end
	end
	return false
end

local function sendSync(player: Player)
	if not player:IsDescendantOf(Players) then return end
	local inv: Inventory? = playerCache[player]
	if not inv then return end

	local data: { [number]: string } = {}
	for i = 1, GameConfig.MAX_SLOTS do
		data[i] = inv[i] or ""
	end
	syncEvent:FireClient(player, data, playerEquipped[player])
end

local function destroyEquippedTool(player: Player)
	local character: Model? = player.Character
	if character then
		for _, child: Instance in character:GetChildren() do
			if child:IsA("Tool") and child:GetAttribute("InventorySlot") then
				child:Destroy()
			end
		end
	end
	local backpack: Instance? = player:FindFirstChildOfClass("Backpack")
	if backpack then
		for _, child: Instance in backpack:GetChildren() do
			if child:IsA("Tool") and child:GetAttribute("InventorySlot") then
				child:Destroy()
			end
		end
	end
end

local function createHandleFromMaster(master: Instance): BasePart?
	local basePart: BasePart? = GameConfig.resolveBasePart(master)
	if not basePart then return nil end
	local handle: BasePart = basePart:Clone()
	handle.Name = "Handle"
	return handle
end

local function createToolForItem(player: Player, itemName: string, slotIndex: number)
	local character: Model? = player.Character
	if not character then return end
	local humanoid: Humanoid? = character:FindFirstChildOfClass("Humanoid")
	if not humanoid or humanoid.Health <= 0 then return end

	destroyEquippedTool(player)

	local tool: Tool = Instance.new("Tool")
	tool.Name = itemName
	tool.CanBeDropped = false
	tool:SetAttribute("InventorySlot", slotIndex)
	tool:SetAttribute("ItemName", itemName)

	local master: Instance? = itemMasters[itemName]
	local handle: BasePart? = master and createHandleFromMaster(master)
	if not handle then
		handle = Instance.new("Part")
		handle.Name = "Handle"
		handle.Size = Vector3.new(1, 1, 1)
		handle.BrickColor = BrickColor.new("Bright blue")
	end

	handle.Anchored = false
	handle.CanCollide = false
	handle.Massless = true
	handle.Parent = tool

	humanoid:EquipTool(tool)

	playerEquipped[player] = slotIndex
	equippedSync:FireClient(player, slotIndex)
end

local function captureMaster(itemName: string, itemInstance: Instance)
	local master: Instance = itemInstance:Clone()
	local masterPrompt: ProximityPrompt? = master:FindFirstChildOfClass("ProximityPrompt")
	if masterPrompt then
		masterPrompt:Destroy()
	end
	master:SetAttribute("BeingPickedUp", nil)
	master.Name = itemName
	master.Parent = mastersFolder
	itemMasters[itemName] = master
end

local function attemptPickup(player: Player, itemPartArg: any)
	if typeof(itemPartArg) ~= "Instance" then return end
	local itemPart: Instance = itemPartArg

	if not itemPart:IsDescendantOf(workspace) then return end
	if not CollectionService:HasTag(itemPart, GameConfig.INTERACTABLE_TAG) then return end
	if itemPart:GetAttribute("BeingPickedUp") then return end
	itemPart:SetAttribute("BeingPickedUp", true)

	local itemName: string = itemPart.Name
	if not validItems[itemName] then
		itemPart:SetAttribute("BeingPickedUp", nil)
		return
	end

	local character: Model? = player.Character
	local rootPart: BasePart? = character and (character:FindFirstChild("HumanoidRootPart") :: BasePart?)
	local targetPart: BasePart? = GameConfig.resolveBasePart(itemPart)
	if not character or not rootPart or not targetPart then
		itemPart:SetAttribute("BeingPickedUp", nil)
		return
	end

	local distance: number = (targetPart.Position - rootPart.Position).Magnitude
	if distance > GameConfig.INTERACTION.MaxDistance + SERVER_DISTANCE_TOLERANCE then
		itemPart:SetAttribute("BeingPickedUp", nil)
		return
	end

	if GameConfig.INTERACTION.RequiresLineOfSight then
		local ignoreList: { Instance } = { character }
		for _, taggedInstance in CollectionService:GetTagged(GameConfig.INTERACTABLE_TAG) do
			table.insert(ignoreList, taggedInstance)
		end
		local clear: boolean = GameConfig.hasLineOfSight(rootPart.Position, targetPart, ignoreList)
		if not clear then
			itemPart:SetAttribute("BeingPickedUp", nil)
			return
		end
	end

	local inv: Inventory? = playerCache[player]
	if not inv then
		itemPart:SetAttribute("BeingPickedUp", nil)
		return
	end

	if ownsItem(inv, itemName) then
		itemPart:SetAttribute("BeingPickedUp", nil)
		return
	end

	local slot: number? = findFreeSlot(inv)
	if not slot then
		itemPart:SetAttribute("BeingPickedUp", nil)
		return
	end

	inv[slot] = itemName
	itemPart:Destroy()
	sendSync(player)
end

local function spawnWorldItem(itemName: string, position: Vector3)
	local master: Instance? = itemMasters[itemName]
	local masterPart: BasePart? = master and GameConfig.resolveBasePart(master)
	local worldPart: BasePart
	if masterPart then
		worldPart = masterPart:Clone()
	else
		worldPart = Instance.new("Part")
		worldPart.Name = itemName
		worldPart.Size = Vector3.new(2, 2, 2)
		worldPart.CanCollide = true
		worldPart.BrickColor = BrickColor.new("Bright blue")
	end

	worldPart.Anchored = false
	worldPart.Position = position

	CollectionService:AddTag(worldPart, GameConfig.INTERACTABLE_TAG)

	worldPart.Parent = workspace
end

local function initializeItems()
	local itemsFolder: Folder = GameConfig.getItemsFolder()
	local itemNames: { string } = GameConfig.discoverItemNames(itemsFolder)

	for _, itemName in itemNames do
		local itemInstance: Instance? = itemsFolder:FindFirstChild(itemName)
		local basePart: BasePart? = itemInstance and GameConfig.resolveBasePart(itemInstance)
		if not itemInstance or not basePart then
			continue
		end

		validItems[itemName] = true
		captureMaster(itemName, itemInstance)

		local oldPrompt: ProximityPrompt? = basePart:FindFirstChildOfClass("ProximityPrompt")
		if oldPrompt then
			oldPrompt:Destroy()
		end

		CollectionService:AddTag(itemInstance, GameConfig.INTERACTABLE_TAG)
	end

	table.freeze(validItems)
end

initializeItems()

equipEvent.OnServerEvent:Connect(function(player: Player, slotIndex: any)
	if type(slotIndex) ~= "number" then return end
	local slotNum: number = math.floor(slotIndex)
	if slotNum < 1 or slotNum > GameConfig.MAX_SLOTS then return end

	local inv: Inventory? = playerCache[player]
	if not inv then return end

	local itemName: string? = inv[slotNum]
	if not itemName then return end

	if playerEquipped[player] == slotNum then
		destroyEquippedTool(player)
		playerEquipped[player] = nil
		equippedSync:FireClient(player, nil)
		return
	end

	createToolForItem(player, itemName, slotNum)
end)

pickupEvent.OnServerEvent:Connect(function(player: Player, itemPartArg: any)
	local now: number = time()
	local last: number? = pickupCooldown[player]
	if last and now - last < PICKUP_COOLDOWN_SECONDS then
		return
	end
	pickupCooldown[player] = now
	attemptPickup(player, itemPartArg)
end)

dropEvent.OnServerEvent:Connect(function(player: Player)
	local equippedSlot: number? = playerEquipped[player]
	if not equippedSlot then return end

	local inv: Inventory? = playerCache[player]
	if not inv then return end

	local itemName: string? = inv[equippedSlot]
	if not itemName then return end

	local character: Model? = player.Character
	if not character then return end
	local rootPart: BasePart? = character:FindFirstChild("HumanoidRootPart") :: BasePart?
	if not rootPart then return end

	inv[equippedSlot] = nil
	playerEquipped[player] = nil
	destroyEquippedTool(player)

	local dropPos: Vector3 = rootPart.Position + rootPart.CFrame.LookVector * GameConfig.DROP_OFFSET
	spawnWorldItem(itemName, dropPos)

	sendSync(player)
end)

local function onPlayerAdded(player: Player)
	local inv: Inventory? = loadData(player)

	if not player:IsDescendantOf(Players) then return end

	if not inv then
		player:Kick("Data failed to load. Please rejoin.")
		return
	end

	playerCache[player] = inv
	playerEquipped[player] = nil

	player.CharacterAdded:Connect(function(character: Model)
		playerEquipped[player] = nil

		local humanoid: Humanoid = character:WaitForChild("Humanoid", 10) :: Humanoid
		if not humanoid then return end

		task.defer(function()
			if player:IsDescendantOf(Players) then
				sendSync(player)
			end
		end)

		humanoid.Died:Connect(function()
			destroyEquippedTool(player)
			playerEquipped[player] = nil
			if player:IsDescendantOf(Players) then
				equippedSync:FireClient(player, nil)
			end
		end)
	end)

	if player.Character then
		task.defer(function()
			sendSync(player)
		end)
	end
end

local function onPlayerRemoving(player: Player)
	if playerCache[player] then
		saveData(player)
	end
	playerCache[player] = nil
	playerEquipped[player] = nil
	pickupCooldown[player] = nil
end

Players.PlayerAdded:Connect(onPlayerAdded)
Players.PlayerRemoving:Connect(onPlayerRemoving)

for _, player: Player in Players:GetPlayers() do
	task.spawn(onPlayerAdded, player)
end

game:BindToClose(function()
	for player: Player, _ in pairs(playerCache) do
		task.spawn(saveData, player)
	end

	local maxWait: number = tick() + 5
	while activeSaves > 0 and tick() < maxWait do
		task.wait(0.1)
	end
end)`,

        'InventoryClient.lua': `--!strict
local Players = game:GetService("Players")
local UserInputService = game:GetService("UserInputService")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local StarterGui = game:GetService("StarterGui")

task.spawn(function()
	local success: boolean = false
	while not success do
		success = pcall(function()
			StarterGui:SetCoreGuiEnabled(Enum.CoreGuiType.Backpack, false)
		end)
		if not success then
			task.wait(0.1)
		end
	end
end)

local configModule: ModuleScript = ReplicatedStorage:WaitForChild("GameConfig") :: ModuleScript
local GameConfig = require(configModule)

local player: Player = Players.LocalPlayer
local playerGui: PlayerGui = player:WaitForChild("PlayerGui") :: PlayerGui

local remoteFolder: Folder = ReplicatedStorage:WaitForChild("InventoryRemotes") :: Folder
local equipEvent: RemoteEvent = remoteFolder:WaitForChild("EquipEvent") :: RemoteEvent
local dropEvent: RemoteEvent = remoteFolder:WaitForChild("DropEvent") :: RemoteEvent
local syncEvent: RemoteEvent = remoteFolder:WaitForChild("SyncInventory") :: RemoteEvent
local equippedSync: RemoteEvent = remoteFolder:WaitForChild("EquippedSync") :: RemoteEvent

local inventoryGui: ScreenGui = playerGui:WaitForChild("Inventory") :: ScreenGui
local container: Frame = inventoryGui:WaitForChild("InventoryContainer") :: Frame

local helpGui: ScreenGui = playerGui:WaitForChild("Help") :: ScreenGui
local helpFrame: Frame = helpGui:WaitForChild("Frame") :: Frame

local slots: { [number]: GuiObject } = {}
local slotLabels: { [number]: TextLabel } = {}

for i = 1, GameConfig.MAX_SLOTS do
	local slot: GuiObject = container:WaitForChild("slot" .. tostring(i)) :: GuiObject
	slots[i] = slot
	slotLabels[i] = slot:WaitForChild("ItemName") :: TextLabel
end

local localInventory: { [number]: string? } = {}
local equippedSlot: number? = nil

local DEFAULT_SLOT_COLOR: Color3 = Color3.fromRGB(60, 60, 60)
local EQUIPPED_SLOT_COLOR: Color3 = Color3.fromRGB(80, 180, 80)

local function updateUI()
	for i = 1, GameConfig.MAX_SLOTS do
		local itemName: string? = localInventory[i]
		if itemName and itemName ~= "" then
			slotLabels[i].Text = itemName
		else
			slotLabels[i].Text = ""
		end

		if equippedSlot == i then
			slots[i].BackgroundColor3 = EQUIPPED_SLOT_COLOR
		else
			slots[i].BackgroundColor3 = DEFAULT_SLOT_COLOR
		end
	end

	helpFrame.Visible = (equippedSlot ~= nil)
end

syncEvent.OnClientEvent:Connect(function(data: any, serverEquipped: any)
	if type(data) ~= "table" then return end
	for i = 1, GameConfig.MAX_SLOTS do
		local val: any = data[i] or data[tostring(i)]
		localInventory[i] = if type(val) == "string" then val else nil
	end
	equippedSlot = if type(serverEquipped) == "number" then serverEquipped else nil
	updateUI()
end)

equippedSync.OnClientEvent:Connect(function(slotIndex: any)
	equippedSlot = if type(slotIndex) == "number" then slotIndex else nil
	updateUI()
end)

local function onSlotClicked(slotIndex: number)
	local itemName: string? = localInventory[slotIndex]
	if not itemName or itemName == "" then return end
	equipEvent:FireServer(slotIndex)
end

for i = 1, GameConfig.MAX_SLOTS do
	local slot: GuiObject = slots[i]
	if slot:IsA("GuiButton") then
		(slot :: GuiButton).Activated:Connect(function()
			onSlotClicked(i)
		end)
	else
		slot.InputBegan:Connect(function(input: InputObject)
			if input.UserInputType == Enum.UserInputType.MouseButton1 or input.UserInputType == Enum.UserInputType.Touch then
				onSlotClicked(i)
			end
		end)
	end
end

local KEY_MAP: { [Enum.KeyCode]: number } = {
	[Enum.KeyCode.One] = 1,
	[Enum.KeyCode.Two] = 2,
	[Enum.KeyCode.Three] = 3,
}

UserInputService.InputBegan:Connect(function(input: InputObject, gameProcessed: boolean)
	if gameProcessed then return end

	if input.KeyCode == Enum.KeyCode.Q then
		if equippedSlot then
			dropEvent:FireServer()
		end
		return
	end

	local slotNum: number? = KEY_MAP[input.KeyCode]
	if slotNum then
		onSlotClicked(slotNum)
	end
end)

helpFrame.Visible = false
updateUI()`,

        'InteractionClient.lua': `--!strict
local Players = game:GetService("Players")
local RunService = game:GetService("RunService")
local CollectionService = game:GetService("CollectionService")
local UserInputService = game:GetService("UserInputService")
local ReplicatedStorage = game:GetService("ReplicatedStorage")

local configModule: ModuleScript = ReplicatedStorage:WaitForChild("GameConfig") :: ModuleScript
local GameConfig = require(configModule)

local player: Player = Players.LocalPlayer
local playerGui: PlayerGui = player:WaitForChild("PlayerGui") :: PlayerGui

local remoteFolder: Folder = ReplicatedStorage:WaitForChild("InventoryRemotes") :: Folder
local pickupEvent: RemoteEvent = remoteFolder:WaitForChild("PickupEvent") :: RemoteEvent

local promptGui: ScreenGui = playerGui:WaitForChild("CustomPromt") :: ScreenGui
local promptFrame: Frame = promptGui:WaitForChild("Frame") :: Frame
promptFrame.Visible = false

local candidates: { [Instance]: BasePart } = {}
local currentTarget: Instance? = nil
local currentHighlight: Highlight? = nil

local function clearTarget()
	if currentHighlight then
		currentHighlight:Destroy()
		currentHighlight = nil
	end
	currentTarget = nil
	promptFrame.Visible = false
end

local function setTarget(target: Instance)
	if currentHighlight then
		currentHighlight:Destroy()
	end

	local highlight: Highlight = Instance.new("Highlight")
	highlight.Name = "InteractHighlight"
	highlight.FillTransparency = 1
	highlight.OutlineColor = Color3.new(1, 1, 1)
	highlight.OutlineTransparency = 0
	highlight.DepthMode = Enum.HighlightDepthMode.Occluded
	highlight.Parent = target

	currentHighlight = highlight
	currentTarget = target
	promptFrame.Visible = true
end

local function trackCandidate(instance: Instance)
	local basePart: BasePart? = GameConfig.resolveBasePart(instance)
	if basePart then
		candidates[instance] = basePart
	end
end

for _, instance in CollectionService:GetTagged(GameConfig.INTERACTABLE_TAG) do
	trackCandidate(instance)
end

CollectionService:GetInstanceAddedSignal(GameConfig.INTERACTABLE_TAG):Connect(trackCandidate)

CollectionService:GetInstanceRemovedSignal(GameConfig.INTERACTABLE_TAG):Connect(function(instance: Instance)
	candidates[instance] = nil
	if instance == currentTarget then
		clearTarget()
	end
end)

RunService.Heartbeat:Connect(function()
	local character: Model? = player.Character
	if not character then
		if currentTarget then
			clearTarget()
		end
		return
	end

	local rootPart: BasePart? = character:FindFirstChild("HumanoidRootPart") :: BasePart?
	if not rootPart then
		if currentTarget then
			clearTarget()
		end
		return
	end

	local closestInstance: Instance? = nil
	local closestPart: BasePart? = nil
	local closestDistance: number = GameConfig.INTERACTION.MaxDistance

	for instance, basePart in candidates do
		if basePart.Parent then
			local distance: number = (basePart.Position - rootPart.Position).Magnitude
			if distance < closestDistance then
				closestInstance = instance
				closestPart = basePart
				closestDistance = distance
			end
		end
	end

	if closestInstance and closestPart and GameConfig.INTERACTION.RequiresLineOfSight then
		local ignoreList: { Instance } = { character }
		for instance in candidates do
			table.insert(ignoreList, instance)
		end
		local clear: boolean = GameConfig.hasLineOfSight(rootPart.Position, closestPart, ignoreList)
		if not clear then
			closestInstance = nil
		end
	end

	if closestInstance ~= currentTarget then
		if closestInstance then
			setTarget(closestInstance)
		else
			clearTarget()
		end
	end
end)

UserInputService.InputBegan:Connect(function(input: InputObject, gameProcessed: boolean)
	if gameProcessed then return end
	if input.KeyCode ~= Enum.KeyCode.E then return end
	if not currentTarget then return end
	pickupEvent:FireServer(currentTarget)
end)
`,

        'GameConfig.lua': `--!strict

local ITEMS_FOLDER_NAME = "Items"
local INTERACTABLE_TAG = "PickupItem"

export type InteractionSettings = {
	MaxDistance: number,
	RequiresLineOfSight: boolean,
}

export type Config = {
	MAX_SLOTS: number,
	DATASTORE_NAME: string,
	DATASTORE_KEY_PREFIX: string,
	DROP_OFFSET: number,
	ITEMS_FOLDER_NAME: string,
	INTERACTABLE_TAG: string,
	INTERACTION: InteractionSettings,
	resolveBasePart: (instance: Instance) -> BasePart?,
	getItemsFolder: () -> Folder,
	discoverItemNames: (itemsFolder: Folder) -> { string },
	hasLineOfSight: (origin: Vector3, targetPart: BasePart, ignoreInstances: { Instance }) -> boolean,
}

local function resolveBasePart(instance: Instance): BasePart?
	if instance:IsA("BasePart") then
		return instance
	elseif instance:IsA("Model") then
		return instance.PrimaryPart
	end
	return nil
end

local function getItemsFolder(): Folder
	return workspace:WaitForChild(ITEMS_FOLDER_NAME) :: Folder
end

local function discoverItemNames(itemsFolder: Folder): { string }
	local seen: { [string]: boolean } = {}
	local names: { string } = {}
	for _, child in itemsFolder:GetChildren() do
		if not resolveBasePart(child) then
			warn(\`[GameConfig] Skipping "{child:GetFullName()}": no BasePart to use as item appearance\`)
			continue
		end
		if seen[child.Name] then
			warn(\`[GameConfig] Duplicate item name "{child.Name}" in {itemsFolder:GetFullName()}, ignoring extra copy\`)
			continue
		end
		seen[child.Name] = true
		table.insert(names, child.Name)
	end
	return names
end

local function hasLineOfSight(origin: Vector3, targetPart: BasePart, ignoreInstances: { Instance }): boolean
	local raycastParams = RaycastParams.new()
	raycastParams.ExcludeInstances = ignoreInstances
	local raycastResult = workspace:Raycast(origin, targetPart.Position - origin, raycastParams)
	return raycastResult == nil
end

local GameConfig: Config = {
	MAX_SLOTS = 3,
	DATASTORE_NAME = "PlayerInventory_v1",
	DATASTORE_KEY_PREFIX = "inv_",
	DROP_OFFSET = 5,
	ITEMS_FOLDER_NAME = ITEMS_FOLDER_NAME,
	INTERACTABLE_TAG = INTERACTABLE_TAG,
	INTERACTION = {
		MaxDistance = 10,
		RequiresLineOfSight = true,
	},
	resolveBasePart = resolveBasePart,
	getItemsFolder = getItemsFolder,
	discoverItemNames = discoverItemNames,
	hasLineOfSight = hasLineOfSight,
}

table.freeze(GameConfig.INTERACTION)
table.freeze(GameConfig)

return GameConfig
`,

        'readme.md': `# 📁 Project Structure

\`\`\`
ReplicatedStorage/
└─ GameConfig               ← ModuleScript

ServerScriptService/
└─ InventoryServer          ← Script

StarterPlayerScripts/
└─ InventoryClient          ← LocalScript
└─ InteractionClient        ← LocalScript
\`\`\``
      }
    },
    round: {
      name: 'Round system',
      files: {
        'ClientMain.luau': `--!strict
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local RunService = game:GetService("RunService")
local Players = game:GetService("Players")

local Maid = require(ReplicatedStorage:WaitForChild("SharedModules"):WaitForChild("Maid"))

local localPlayer = Players.LocalPlayer

local Events = ReplicatedStorage:WaitForChild("Events")
local TimeSyncEvent = Events:WaitForChild("TimeSyncEvent") :: RemoteEvent

local currentEndTime: number = 0
local uiUpdateMaid = Maid.new()
local lifetimeMaid = Maid.new()

local function FormatTime(seconds: number): string
	local minutes = math.floor(seconds / 60)
	local secs = math.floor(seconds % 60)
	return string.format("%02d:%02d", minutes, secs)
end

local function StartUIUpdate()
	uiUpdateMaid:DoCleaning()
	local playerGui = localPlayer:WaitForChild("PlayerGui")
	local roundGui = playerGui:WaitForChild("RoundGui")
	local timerLabel = roundGui:WaitForChild("TimerLabel") :: TextLabel

	uiUpdateMaid:GiveTask(RunService.RenderStepped:Connect(function()
		local remainingTime = currentEndTime - workspace:GetServerTimeNow()
		if remainingTime <= 0 then
			timerLabel.Text = "00:00"
			uiUpdateMaid:DoCleaning()
			return
		end
		timerLabel.Text = FormatTime(remainingTime)
	end))
end

lifetimeMaid:GiveTask(TimeSyncEvent.OnClientEvent:Connect(function(endTime: number)
	currentEndTime = endTime
	StartUIUpdate()
end))

lifetimeMaid:GiveTask(localPlayer.CharacterAdded:Connect(function()
	if currentEndTime > workspace:GetServerTimeNow() then
		StartUIUpdate()
	end
end))`,

        'ClientSwordController.luau': `--!strict

local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Maid = require(ReplicatedStorage.SharedModules.Maid)
local SwordHitEvent = ReplicatedStorage.Events.SwordHitEvent

local ClientSwordController = {}
ClientSwordController.__index = ClientSwordController

export type ClientSwordController = {
	Tool: Tool,
	_maid: Maid.Maid,
	_equipMaid: Maid.Maid,
	_lastAttack: number,
	Connect: (self: ClientSwordController) -> (),
	_onActivated: (self: ClientSwordController) -> (),
	_onEquipped: (self: ClientSwordController) -> (),
	_onUnequipped: (self: ClientSwordController) -> (),
}

function ClientSwordController.new(tool: Tool): ClientSwordController
	local self = setmetatable({} :: ClientSwordController, ClientSwordController)
	self.Tool = tool
	self._maid = Maid.new()
	self._equipMaid = Maid.new()
	self._lastAttack = 0
	return self
end

function ClientSwordController:_onActivated(): ()
	local currentTime = os.clock()
	if currentTime - self._lastAttack < 0.5 then
		return
	end

	local character = Players.LocalPlayer.Character
	if not character or not character:FindFirstChild("HumanoidRootPart") then
		return
	end

	self._lastAttack = currentTime
	SwordHitEvent:FireServer()
end

function ClientSwordController:_onEquipped(): ()
	self._equipMaid:DoCleaning()
	self._equipMaid:GiveTask(self.Tool.Activated:Connect(function()
		self:_onActivated()
	end))
end

function ClientSwordController:_onUnequipped(): ()
	self._equipMaid:DoCleaning()
end

function ClientSwordController:Connect(): ()
	self._maid:GiveTask(self.Tool.Equipped:Connect(function()
		self:_onEquipped()
	end))
	self._maid:GiveTask(self.Tool.Unequipped:Connect(function()
		self:_onUnequipped()
	end))
end

local tool = script.Parent
if tool:IsA("Tool") then
	local controller = ClientSwordController.new(tool)
	controller:Connect()
end

return ClientSwordController`,

        'DataManager.luau': `--!strict

local Players = game:GetService("Players")
local ProfileService = require(script.Parent.ProfileService)
local Maid = require(game:GetService("ReplicatedStorage").SharedModules.Maid)

export type DataManager = {
	_maid: Maid.Maid,
	_profiles: { [Player]: any },
	_loadingProfiles: { [Player]: boolean },
	_profileStore: any,
	_initialize: (self: DataManager) -> (),
	_createLeaderstats: (self: DataManager, player: Player, profile: any) -> (),
	_updateLeaderstats: (self: DataManager, player: Player, profile: any) -> (),
	_onPlayerAdded: (self: DataManager, player: Player) -> (),
	_onPlayerRemoving: (self: DataManager, player: Player) -> (),
	GetProfile: (self: DataManager, player: Player) -> any,
	AddWins: (self: DataManager, player: Player, amount: number) -> (),
	AddCoins: (self: DataManager, player: Player, amount: number) -> (),
	Destroy: (self: DataManager) -> (),
}

local DataManager = {}
DataManager.__index = DataManager

function DataManager.new(): DataManager
	local self = setmetatable({}, DataManager)
	self._maid = Maid.new()
	self._profiles = {}
	self._loadingProfiles = {}
	self._profileStore = ProfileService.GetProfileStore("PlayerData_v1", {
		Wins = 0,
		Coins = 0
	})
	self:_initialize()
	return self
end

function DataManager:_initialize(): ()
	local function onPlayerAdded(player)
		self:_onPlayerAdded(player)
	end
	
	self._maid:GiveTask(Players.PlayerAdded:Connect(onPlayerAdded))
	self._maid:GiveTask(Players.PlayerRemoving:Connect(function(player)
		self:_onPlayerRemoving(player)
	end))
	
	for _, player in Players:GetPlayers() do
		task.spawn(onPlayerAdded, player)
	end
end

function DataManager:_createLeaderstats(player: Player, profile: any)
	local leaderstats = Instance.new("Folder")
	leaderstats.Name = "leaderstats"
	leaderstats.Parent = player

	local winsValue = Instance.new("IntValue")
	winsValue.Name = "Wins"
	winsValue.Value = profile.Data.Wins
	winsValue.Parent = leaderstats

	local coinsValue = Instance.new("IntValue")
	coinsValue.Name = "Coins"
	coinsValue.Value = profile.Data.Coins
	coinsValue.Parent = leaderstats
end

function DataManager:_updateLeaderstats(player: Player, profile: any)
	local leaderstats = player:FindFirstChild("leaderstats")
	if not leaderstats then
		return
	end

	local winsValue = leaderstats:FindFirstChild("Wins")
	local coinsValue = leaderstats:FindFirstChild("Coins")

	if winsValue and winsValue:IsA("IntValue") then
		winsValue.Value = profile.Data.Wins
	end

	if coinsValue and coinsValue:IsA("IntValue") then
		coinsValue.Value = profile.Data.Coins
	end
end

function DataManager:_onPlayerAdded(player: Player): ()
	if self._profiles[player] ~= nil or self._loadingProfiles[player] then
		return
	end
	self._loadingProfiles[player] = true

	local success, profile = pcall(function()
		return self._profileStore:LoadProfileAsync("Player_" .. player.UserId, "ForceLoad")
	end)
	
	self._loadingProfiles[player] = nil
	
	if not success then
		player:Kick("Data loading failed. Please rejoin.")
		return
	end

	if profile ~= nil then
		profile:ListenToRelease(function()
			self._profiles[player] = nil
			player:Kick("Data session terminated elsewhere")
		end)

		if player.Parent == Players then
			self._profiles[player] = profile
			self:_createLeaderstats(player, profile)
		else
			profile:Release()
		end
	else
		player:Kick("Data loading failed. Please rejoin.")
	end
end

function DataManager:_onPlayerRemoving(player: Player): ()
	local profile = self._profiles[player]
	if profile then
		profile:Release()
		self._profiles[player] = nil
	end
end

function DataManager:GetProfile(player: Player): any
	return self._profiles[player]
end

function DataManager:AddWins(player: Player, amount: number)
	local profile = self._profiles[player]
	if not profile then
		return
	end

	profile.Data.Wins += amount
	self:_updateLeaderstats(player, profile)
end

function DataManager:AddCoins(player: Player, amount: number)
	local profile = self._profiles[player]
	if not profile then
		return
	end

	profile.Data.Coins += amount
	self:_updateLeaderstats(player, profile)
end

function DataManager:Destroy(): ()
	self._maid:DoCleaning()
end

return DataManager`,

        'GameConfig.luau': `--!strict

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

        'Maid.luau': `--!strict

export type MaidTask = RBXScriptConnection | Instance | thread | () -> () | { Destroy: (any) -> () }

export type Maid = {
	_tasks: { [any]: MaidTask },
	GiveTask: (self: Maid, task: MaidTask) -> MaidTask,
	DoCleaning: (self: Maid) -> (),
	IsCleaning: (self: Maid) -> boolean,
}

local Maid = {}
Maid.__index = Maid

function Maid.new(): Maid
	local self = setmetatable({}, Maid)
	self._tasks = {} :: { [any]: MaidTask }
	return self
end

function Maid:GiveTask(task: MaidTask): MaidTask
	if not task then return task end
	self._tasks[task] = task
	return task
end

function Maid:DoCleaning(): ()
	local tasks = self._tasks
	self._tasks = {} :: { [any]: MaidTask }

	for trackedTask, _ in pairs(tasks) do
		local taskType = typeof(trackedTask)

		if taskType == "function" then
			trackedTask()
		elseif taskType == "RBXScriptConnection" then
			(trackedTask :: RBXScriptConnection):Disconnect()
		elseif taskType == "thread" then
			task.cancel(trackedTask)
		elseif taskType == "Instance" then
			trackedTask:Destroy()
		elseif taskType == "table" and typeof(trackedTask.Destroy) == "function" then
			trackedTask:Destroy()
		end
	end
end

function Maid:IsCleaning(): boolean
	return next(self._tasks) ~= nil
end

return Maid`,

        'Main.luau': `--!strict

local ServerScriptService = game:GetService("ServerScriptService")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Maid = require(ReplicatedStorage.SharedModules.Maid)

local TimerService = require(ServerScriptService.ServerModules.TimerService)
local roundManager = require(ServerScriptService.ServerModules.RoundManagerSingleton)
local GameConfig = require(ReplicatedStorage.SharedModules.GameConfig)
local maid = Maid.new()
local Players = game:GetService("Players")

local INTERMISSION_DURATION = GameConfig.INTERMISSION_DURATION
local INGAME_DURATION = GameConfig.INGAME_DURATION
local CLEANUP_DURATION = GameConfig.CLEANUP_DURATION
local MIN_PLAYERS = GameConfig.MIN_PLAYERS

local function runGameLoop()
	while true do
		local success, errorMessage = pcall(function()
			roundManager:TransitionToState("Intermission")
			TimerService.StartTimer(INTERMISSION_DURATION)
			task.wait(INTERMISSION_DURATION)

			local players = Players:GetPlayers()
			if #players < MIN_PLAYERS then
				task.wait(5)
				return
			end

			roundManager:TransitionToState("InGame")
			TimerService.StartTimer(INGAME_DURATION)
			local roundEndedRef = roundManager.RoundEnded
			local timeout = task.delay(INGAME_DURATION, function()
				roundEndedRef:Fire()
			end)
			roundEndedRef.Event:Wait()
			task.cancel(timeout)

			roundManager:TransitionToState("Cleanup")
			TimerService.StartTimer(CLEANUP_DURATION)
			task.wait(CLEANUP_DURATION)
		end)
		
		if not success then
			warn("Game loop error: " .. tostring(errorMessage))
			task.wait(5)
			continue
		end
	end
end

local playerMaids: { [Player]: RBXScriptConnection } = {}

maid:GiveTask(Players.PlayerAdded:Connect(function(player)
	playerMaids[player] = player.CharacterAdded:Connect(function()
		local currentState = roundManager:GetCurrentState()
		if currentState == "Lobby" or currentState == "Intermission" then
			task.wait(0.1)
			local lobby = workspace:FindFirstChild("Map") and workspace.Map:FindFirstChild("Lobby")
			if lobby then
				roundManager._playerManager:TeleportPlayersTo({player}, lobby)
			end
		end
	end)
end))

maid:GiveTask(Players.PlayerRemoving:Connect(function(player)
	if playerMaids[player] then
		playerMaids[player]:Disconnect()
		playerMaids[player] = nil
	end
end))

maid:GiveTask(task.spawn(runGameLoop))
`,

        'PlayerManager.luau': `--!strict

local Players = game:GetService("Players")
local ServerStorage = game:GetService("ServerStorage")

export type PlayerManager = {
	GetAlivePlayers: (self: PlayerManager) -> {Player},
	TeleportPlayersTo: (self: PlayerManager, players: {Player}, destinationFolder: Folder) -> (),
	GiveSword: (self: PlayerManager, player: Player) -> (),
	ClearSwords: (self: PlayerManager, player: Player) -> (),
	Destroy: (self: PlayerManager) -> (),
}

local PlayerManager = {}
PlayerManager.__index = PlayerManager

function PlayerManager.new(): PlayerManager
	local self = setmetatable({}, PlayerManager)
	return self
end

function PlayerManager:GetAlivePlayers(): {Player}
	local alivePlayers: {Player} = {}
	
	for _, player in Players:GetPlayers() do
		local character = player.Character
		if character then
			local humanoid = character:FindFirstChildOfClass("Humanoid")
			if humanoid and humanoid.Health > 0 then
				table.insert(alivePlayers, player)
			end
		end
	end
	
	return alivePlayers
end

function PlayerManager:TeleportPlayersTo(players: {Player}, destinationFolder: Folder): ()
	if not destinationFolder then
		return
	end
	
	local spawnPoints = destinationFolder:GetChildren()
	
	if #spawnPoints == 0 then
		return
	end
	
	for _, player in players do
		local character = player.Character
		if character then
			local randomPart = spawnPoints[math.random(1, #spawnPoints)]
			if randomPart:IsA("BasePart") then
				pcall(function()
					character:PivotTo(randomPart.CFrame + Vector3.new(0, 3, 0))
				end)
			end
		end
	end
end

function PlayerManager:GiveSword(player: Player): ()
	local swordTemplate = ServerStorage:FindFirstChild("ClassicSword")
	if not swordTemplate then
		return
	end
	local clone = swordTemplate:Clone()
	clone.CanBeDropped = false
	clone.Parent = player.Backpack
end

function PlayerManager:ClearSwords(player: Player): ()
	local backpackSword = player.Backpack:FindFirstChild("ClassicSword")
	if backpackSword then
		backpackSword:Destroy()
	end

	local character = player.Character
	if character then
		local characterSword = character:FindFirstChild("ClassicSword")
		if characterSword then
			characterSword:Destroy()
		end
	end
end

function PlayerManager:Destroy(): ()
end

return PlayerManager`,

        'RoundManager.luau': `--!strict

local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Players = game:GetService("Players")
local MaidModule = require(ReplicatedStorage.SharedModules.Maid)
local GameConfig = require(ReplicatedStorage.SharedModules.GameConfig)
local PlayerManagerModule = require(script.Parent.PlayerManager)
local DataManagerModule = require(script.Parent.DataManager)

export type RoundState = "Lobby" | "Intermission" | "InGame" | "Cleanup"

export type RoundManager = {
	CurrentState: RoundState,
	PreviousState: RoundState?,
	CurrentMaid: MaidModule.Maid,
	RoundEnded: BindableEvent,
	_participatingPlayers: { [Player]: boolean },
	_playerManager: PlayerManagerModule.PlayerManager,
	_dataManager: DataManagerModule.DataManager,
	TransitionToState: (self: RoundManager, newState: RoundState) -> (),
	GetCurrentState: (self: RoundManager) -> RoundState,
	StartLobby: (self: RoundManager) -> (),
	StartIntermission: (self: RoundManager) -> (),
	StartGame: (self: RoundManager) -> (),
	StartCleanup: (self: RoundManager) -> (),
	CheckWinCondition: (self: RoundManager) -> (),
	Destroy: (self: RoundManager) -> (),
}

local RoundManager = {}
RoundManager.__index = RoundManager

function RoundManager.new(): RoundManager
	local self = setmetatable({}, RoundManager)
	self.CurrentState = "Lobby"
	self.PreviousState = nil
	self.CurrentMaid = MaidModule.new()
	self.RoundEnded = Instance.new("BindableEvent")
	self.CurrentMaid:GiveTask(self.RoundEnded)
	self._participatingPlayers = {}
	self._playerManager = PlayerManagerModule.new()
	self._dataManager = DataManagerModule.new()
	return self
end

function RoundManager:GetCurrentState(): RoundState
	return self.CurrentState
end

function RoundManager:TransitionToState(newState: RoundState): ()
	if newState == self.CurrentState then
		return
	end

	self.CurrentMaid:DoCleaning()

	self.PreviousState = self.CurrentState
	self.CurrentState = newState

	self.CurrentMaid = MaidModule.new()
	self.RoundEnded = Instance.new("BindableEvent")
	self.CurrentMaid:GiveTask(self.RoundEnded)

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

function RoundManager:StartLobby(): ()
	local lobby = workspace:FindFirstChild("Map") and workspace.Map:FindFirstChild("Lobby")
	if lobby then
		local allPlayers = Players:GetPlayers()
		self._playerManager:TeleportPlayersTo(allPlayers, lobby)

		for _, player in allPlayers do
			self._playerManager:ClearSwords(player)
		end
	end
end

function RoundManager:StartIntermission(): ()
	local lobby = workspace:FindFirstChild("Map") and workspace.Map:FindFirstChild("Lobby")
	if lobby then
		local allPlayers = Players:GetPlayers()
		self._playerManager:TeleportPlayersTo(allPlayers, lobby)
	end
end

function RoundManager:CheckWinCondition(): ()
	if self.CurrentState ~= "InGame" then
		return
	end

	local aliveCount = 0
	for _, player in self._playerManager:GetAlivePlayers() do
		if self._participatingPlayers[player] then
			aliveCount += 1
		end
	end

	if aliveCount <= 1 then
		self.RoundEnded:Fire()
	end
end

function RoundManager:StartGame(): ()
	table.clear(self._participatingPlayers)
	local alivePlayers = self._playerManager:GetAlivePlayers()

	local arena = workspace:FindFirstChild("Map") and workspace.Map:FindFirstChild("Arena")
	if not arena then
		return
	end

	self._playerManager:TeleportPlayersTo(alivePlayers, arena)

	for _, player in alivePlayers do
		self._participatingPlayers[player] = true
		self._playerManager:GiveSword(player)

		local character = player.Character
		if character then
			local humanoid = character:FindFirstChildOfClass("Humanoid")
			if humanoid then
				local connection = humanoid.Died:Connect(function()
					self:CheckWinCondition()
				end)
				self.CurrentMaid:GiveTask(connection)
			end
		end
	end

	local playerRemovingConnection = Players.PlayerRemoving:Connect(function(player)
		self._participatingPlayers[player] = nil
		self:CheckWinCondition()
	end)
	self.CurrentMaid:GiveTask(playerRemovingConnection)
end

function RoundManager:StartCleanup(): ()
	local winner = nil
	for _, player in self._playerManager:GetAlivePlayers() do
		if self._participatingPlayers[player] then
			winner = player
			break
		end
	end

	if winner then
		self._dataManager:AddWins(winner, GameConfig.WIN_AMOUNT)
		self._dataManager:AddCoins(winner, GameConfig.WIN_COINS)
	end
	
	table.clear(self._participatingPlayers)

	for _, player in Players:GetPlayers() do
		self._playerManager:ClearSwords(player)

		if player.Character then
			local humanoid = player.Character:FindFirstChildOfClass("Humanoid")
			if not humanoid or humanoid.Health <= 0 then
				player:LoadCharacter()
			end
		else
			player:LoadCharacter()
		end
	end

	task.wait(0.5)

	local lobby = workspace:FindFirstChild("Map") and workspace.Map:FindFirstChild("Lobby")
	if not lobby then
		return
	end

	local allPlayers = Players:GetPlayers()
	self._playerManager:TeleportPlayersTo(allPlayers, lobby)
end

function RoundManager:Destroy(): ()
	self.CurrentMaid:DoCleaning()
	self._playerManager:Destroy()
	self._dataManager:Destroy()
end

return RoundManager`,

        'RoundManagerSingleton.luau': `--!strict

local RoundManager = require(script.Parent.RoundManager)

export type RoundManager = RoundManager.RoundManager

local instance: RoundManager = RoundManager.new()

return instance`,

        'ServerSwordHandler.luau': `--!strict

local ReplicatedStorage = game:GetService("ReplicatedStorage")
local ServerScriptService = game:GetService("ServerScriptService")
local Players = game:GetService("Players")
local Maid = require(ReplicatedStorage.SharedModules.Maid)
local GameConfig = require(ReplicatedStorage.SharedModules.GameConfig)
local SwordHitEvent = ReplicatedStorage.Events.SwordHitEvent
local roundManager = require(ServerScriptService.ServerModules.RoundManagerSingleton)

local maid = Maid.new()
local debounceTable: {[Player]: number} = {}

local function getCharacter(player: Player): Model?
	return player.Character
end

local function hasToolEquipped(player: Player, toolName: string): boolean
	local character = getCharacter(player)
	if not character then
		return false
	end

	for _, item in character:GetChildren() do
		if item:IsA("Tool") and item.Name == toolName then
			return true
		end
	end

	return false
end

local function onSwordHit(player: Player)
	if roundManager:GetCurrentState() ~= "InGame" then
		return
	end

	local character = player.Character
	if not character or script.Parent.Parent ~= character then
		return
	end

	local currentTime = os.clock()

	if debounceTable[player] and currentTime - debounceTable[player] < GameConfig.SWORD_DEBOUNCE then
		return
	end

	local attackerCharacter = character

	local attackerHumanoidRootPart = attackerCharacter:FindFirstChild("HumanoidRootPart")
	if not attackerHumanoidRootPart then
		return
	end

	local tool = script.Parent
	if not hasToolEquipped(player, tool.Name) then
		return
	end

	local handle = tool:FindFirstChild("Handle")
	if not handle then
		return
	end

	local spherecastParams = RaycastParams.new()
	spherecastParams.FilterDescendantsInstances = {attackerCharacter}
	spherecastParams.FilterType = Enum.RaycastFilterType.Exclude

	local lookDirection = attackerHumanoidRootPart.CFrame.LookVector
	local rayOrigin = handle.Position
	local rayDirection = lookDirection * GameConfig.SPHERECAST_RANGE

	local rayResult = workspace:Spherecast(rayOrigin, GameConfig.SPHERECAST_RADIUS, rayDirection, spherecastParams)

	if not rayResult then
		return
	end

	local hitPart = rayResult.Instance
	local targetCharacter = hitPart.Parent
	if not targetCharacter or not targetCharacter:IsA("Model") then
		return
	end

	local targetHumanoid = targetCharacter:FindFirstChildOfClass("Humanoid")
	if not targetHumanoid then
		return
	end

	local targetHumanoidRootPart = targetCharacter:FindFirstChild("HumanoidRootPart")
	if not targetHumanoidRootPart then
		return
	end

	local distance = (attackerHumanoidRootPart.Position - targetHumanoidRootPart.Position).Magnitude
	if distance > GameConfig.MAX_DAMAGE_DISTANCE then
		return
	end

	if targetCharacter == attackerCharacter then
		return
	end

	targetHumanoid:TakeDamage(GameConfig.SWORD_DAMAGE)
	debounceTable[player] = currentTime
end

local function onPlayerRemoving(player: Player)
	debounceTable[player] = nil
end

maid:GiveTask(SwordHitEvent.OnServerEvent:Connect(onSwordHit))
maid:GiveTask(Players.PlayerRemoving:Connect(onPlayerRemoving))
maid:GiveTask(script.Parent.AncestryChanged:Connect(function()
	if not script.Parent:IsDescendantOf(game) then
		maid:DoCleaning()
	end
end))`,

        'TimerService.luau': `--!strict

local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Players = game:GetService("Players")

local Events: Folder
do
	local found = ReplicatedStorage:FindFirstChild("Events")
	if found and found:IsA("Folder") then
		Events = found
	else
		local f = Instance.new("Folder")
		f.Name = "Events"
		f.Parent = ReplicatedStorage
		Events = f
	end
end

local TimeSyncEvent: RemoteEvent
do
	local found = Events:FindFirstChild("TimeSyncEvent")
	if found and found:IsA("RemoteEvent") then
		TimeSyncEvent = found
	else
		local e = Instance.new("RemoteEvent")
		e.Name = "TimeSyncEvent"
		e.Parent = Events
		TimeSyncEvent = e
	end
end

local currentEndTime: number = 0

local TimerService = {}

function TimerService.StartTimer(durationInSeconds: number): number
	local endTime = workspace:GetServerTimeNow() + durationInSeconds
	currentEndTime = endTime
	TimeSyncEvent:FireAllClients(endTime)
	return endTime
end

local maid = require(ReplicatedStorage.SharedModules.Maid).new()

maid:GiveTask(Players.PlayerAdded:Connect(function(player: Player)
	if currentEndTime > workspace:GetServerTimeNow() then
		TimeSyncEvent:FireClient(player, currentEndTime)
	end
end))

task.spawn(function()
	for _, player in Players:GetPlayers() do
		if currentEndTime > workspace:GetServerTimeNow() then
			TimeSyncEvent:FireClient(player, currentEndTime)
		end
	end
end)

return TimerService`,

        'readme.md': `## 📂 Project Structure

\`\`\`text
ReplicatedStorage/
├── Events/
│   └── SwordHitEvent                ← RemoteEvent
└── SharedModules/
    ├── GameConfig                   ← ModuleScript
    └── Maid                         ← ModuleScript

ServerScriptService/
├── Core/
│   └── Main                         ← Script
└── ServerModules/
    ├── DataManager                  ← ModuleScript
    ├── PlayerManager                ← ModuleScript
    ├── ProfileService               ← ModuleScript
    ├── RoundManager                 ← ModuleScript
    ├── RoundManagerSingleton        ← ModuleScript
    └── TimerService                 ← ModuleScript

ServerStorage/
└── ClassicSword/
    ├── ServerSwordHandler           ← Script
    ├── ClientSwordController        ← LocalScript
    └── Handle                       ← Part

StarterGui/

StarterPack/

StarterPlayer/
├── StarterCharacterScripts/
└── StarterPlayerScripts/
    └── ClientMain                   ← LocalScript`
      }
    },

    plot: {
      name: 'Basic plot system',
      files: {
        'PlotClaimSystem.lua': `--!strict

local Players = game:GetService("Players")
local Workspace = game:GetService("Workspace")
local ServerScriptService = game:GetService("ServerScriptService")

local GameConfig = require(ServerScriptService.GameConfig)

type PlotRecord = {
	pad: BasePart,
	gui: BillboardGui,
	label: TextLabel,
	owner: Player?,
	touchConnection: RBXScriptConnection,
}

local plots: {[Instance]: PlotRecord} = {}
local ownerToPlot: {[Player]: Instance} = {}
local touchDebounce: {[Player]: boolean} = {}

local function createOwnerDisplay(pad: BasePart): (BillboardGui, TextLabel)
	local config = GameConfig.OwnerDisplay

	local gui = Instance.new("BillboardGui")
	gui.Name = config.Name
	gui.Adornee = pad
	gui.Size = config.Size
	gui.StudsOffsetWorldSpace = Vector3.new(0, pad.Size.Y / 2 + config.VerticalMargin, 0)
	gui.AlwaysOnTop = config.AlwaysOnTop
	gui.MaxDistance = config.MaxDistance
	gui.LightInfluence = config.LightInfluence
	gui.Enabled = false

	local label = Instance.new("TextLabel")
	label.Name = "OwnerLabel"
	label.Size = UDim2.fromScale(1, 1)
	label.BackgroundTransparency = 1
	label.Font = config.Font
	label.TextScaled = true
	label.TextColor3 = config.TextColor
	label.TextStrokeColor3 = config.TextStrokeColor
	label.TextStrokeTransparency = config.TextStrokeTransparency
	label.Text = ""
	label.Parent = gui

	gui.Parent = pad
	return gui, label
end

local function claimPlot(plot: Instance, record: PlotRecord, player: Player): ()
	record.owner = player
	ownerToPlot[player] = plot
	plot:SetAttribute("Owner", player.Name)
	record.label.Text = string.format(GameConfig.OwnerDisplay.TextFormat, player.DisplayName)
	record.gui.Enabled = true
end

local function releasePlot(plot: Instance, record: PlotRecord): ()
	local owner = record.owner
	if not owner then
		return
	end
	record.owner = nil
	ownerToPlot[owner] = nil
	plot:SetAttribute("Owner", "")
	record.label.Text = ""
	record.gui.Enabled = false
end

local function onPadTouched(plot: Instance, record: PlotRecord, otherPart: BasePart): ()
	local rawParent = otherPart.Parent
	if not rawParent or not rawParent:IsA("Model") then
		return
	end
	local character = rawParent :: Model

	local humanoid = character:FindFirstChildOfClass("Humanoid")
	if not humanoid or humanoid.Health <= 0 then
		return
	end

	local player = Players:GetPlayerFromCharacter(character)
	if not player then
		return
	end

	if touchDebounce[player] then
		return
	end
	touchDebounce[player] = true
	task.delay(GameConfig.Claiming.TouchDebounceSeconds, function()
		touchDebounce[player] = nil
	end)

	if record.owner ~= nil or ownerToPlot[player] ~= nil then
		return
	end

	claimPlot(plot, record, player)
end

local function resolvePad(plot: Instance): BasePart?
	if plot:IsA("BasePart") then
		return plot
	end
	local rawPad = plot:FindFirstChild(GameConfig.Plots.ClaimPadName)
	if rawPad and rawPad:IsA("BasePart") then
		return rawPad
	end
	return nil
end

local function setupPlot(plot: Instance): ()
	if plots[plot] then
		return
	end

	local pad = resolvePad(plot)
	if not pad then
		warn(string.format("[PlotClaimSystem] '%s' has no usable ClaimPad, skipping.", plot:GetFullName()))
		return
	end

	plot:SetAttribute("Owner", "")
	local gui, label = createOwnerDisplay(pad)

	local record: PlotRecord = {
		pad = pad,
		gui = gui,
		label = label,
		owner = nil,
		touchConnection = nil :: any,
	}

	record.touchConnection = pad.Touched:Connect(function(otherPart: BasePart)
		onPadTouched(plot, record, otherPart)
	end)

	plots[plot] = record
	GameConfig.Plots.Registered[plot] = pad
end

local function teardownPlot(plot: Instance): ()
	local record = plots[plot]
	if not record then
		return
	end

	GameConfig.Plots.Registered[plot] = nil

	if record.owner then
		ownerToPlot[record.owner] = nil
	end

	record.touchConnection:Disconnect()
	record.gui:Destroy()
	plots[plot] = nil
end

local function onPlayerRemoving(player: Player): ()
	touchDebounce[player] = nil
	local plot = ownerToPlot[player]
	if not plot then
		return
	end
	local record = plots[plot]
	if not record then
		return
	end
	releasePlot(plot, record)
end

local function initializePlots(): ()
	local plotsFolder = Workspace:WaitForChild(GameConfig.Plots.FolderName)

	plotsFolder.ChildAdded:Connect(function(child: Instance)
		task.defer(function()
			if child.Parent == plotsFolder then
				setupPlot(child)
			end
		end)
	end)

	plotsFolder.ChildRemoved:Connect(teardownPlot)

	for _, child in plotsFolder:GetChildren() do
		setupPlot(child)
	end
end

Players.PlayerRemoving:Connect(onPlayerRemoving)
initializePlots()`,

        'GameConfig.lua': `--!strict

local GameConfig = {}

GameConfig.Plots = {
	FolderName = "Plots",
	ClaimPadName = "ClaimPad",
	Registered = {} :: {[Instance]: BasePart},
}

GameConfig.OwnerDisplay = {
	Name = "OwnerDisplay",
	TextFormat = "%s's Plot",
	VerticalMargin = 12,
	Size = UDim2.fromOffset(200, 50),
	MaxDistance = 120,
	AlwaysOnTop = true,
	LightInfluence = 0,
	Font = Enum.Font.GothamBold,
	TextColor = Color3.fromRGB(255, 255, 255),
	TextStrokeColor = Color3.fromRGB(0, 0, 0),
	TextStrokeTransparency = 0.2,
}

GameConfig.Claiming = {
	TouchDebounceSeconds = 1,
}

return GameConfig`,

        'readme.md': `## 📁 Project Structure

\`\`\`
ServerScriptService/
└── PlotClaimSystem             ← Script
└── GameConfig                  ← Module script
\`\`\``
      }
    },

    notify: {
      name: 'Notification system',
      files: {
        'ImportantNotificationBootstrap.lua': `--!strict
local ReplicatedStorage: ReplicatedStorage = game:GetService("ReplicatedStorage")

local eventName: string = "ImportantNotificationEvent"
local existing: Instance? = ReplicatedStorage:FindFirstChild(eventName)

if existing then
	if existing:IsA("RemoteEvent") then
		return
	end
	existing:Destroy()
end

local remote: RemoteEvent = Instance.new("RemoteEvent")
remote.Name = eventName
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

local screenGui: ScreenGui? = script:FindFirstAncestorOfClass("ScreenGui")
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
local queueToken: number = 0
local cancelCurrentNotification: CancelHandler? = nil
local activeConnections: { RBXScriptConnection } = {}

local function collectAnimatables(root: Instance): ({ TextObject }, { ImageObject }, { GuiObject }, { UIStroke })
	local texts: { TextObject } = {}
	local images: { ImageObject } = {}
	local backgrounds: { GuiObject } = {}
	local strokes: { UIStroke } = {}

	local function add(instance: Instance): ()
		if instance:IsA("TextLabel") or instance:IsA("TextButton") or instance:IsA("TextBox") then
			table.insert(texts, instance :: TextObject)
			table.insert(backgrounds, instance :: GuiObject)
		elseif instance:IsA("ImageLabel") or instance:IsA("ImageButton") then
			table.insert(images, instance :: ImageObject)
			table.insert(backgrounds, instance :: GuiObject)
		elseif instance:IsA("Frame") then
			table.insert(backgrounds, instance :: GuiObject)
		elseif instance:IsA("UIStroke") then
			table.insert(strokes, instance :: UIStroke)
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

	local anchorX: number = (templateAbsolutePosition.X - overlayAbsolutePosition.X) + (templateAbsoluteSize.X * anchor.X)
	local anchorY: number = (templateAbsolutePosition.Y - overlayAbsolutePosition.Y) + (templateAbsoluteSize.Y * anchor.Y)

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

local function playAndDestroyTweens(tweens: { Tween }): ()
	for _: number, tween: Tween in ipairs(tweens) do
		tween:Play()
	end
	if #tweens > 0 then
		tweens[1].Completed:Wait()
	end
	for _: number, tween: Tween in ipairs(tweens) do
		tween:Destroy()
	end
end

local function cancelAndDestroyTweens(tweens: { Tween }): ()
	for _: number, tween: Tween in ipairs(tweens) do
		tween:Cancel()
		tween:Destroy()
	end
end

local function applyText(instance: Instance, text: string): ()
	if instance:IsA("TextLabel") or instance:IsA("TextButton") or instance:IsA("TextBox") then
		local textObj: TextObject = instance :: TextObject
		textObj.Text = text
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

	local texts: { TextObject }, images: { ImageObject }, backgrounds: { GuiObject }, strokes: { UIStroke } = collectAnimatables(notification)
	local originals: Originals = storeOriginals(texts, images, backgrounds, strokes)

	setHidden(texts, images, backgrounds, strokes)

	local targetPosition: UDim2 = layout.position
	local endPosition: UDim2 = UDim2.fromOffset(layout.position.X.Offset, layout.position.Y.Offset - 10)

	local introTweens: { Tween } = buildIntroTweens(notification, texts, images, backgrounds, strokes, originals, targetPosition)

	for _: number, tween: Tween in ipairs(introTweens) do
		tween:Play()
	end

	if #introTweens > 0 then
		introTweens[1].Completed:Wait()
	end

	if cancelled or not notification.Parent then
		cancelAndDestroyTweens(introTweens)
		pcall(function(): ()
			notification:Destroy()
		end)
		return
	end

	for _: number, tween: Tween in ipairs(introTweens) do
		tween:Destroy()
	end

	task.wait(0.85)

	if cancelled or not notification.Parent then
		pcall(function(): ()
			notification:Destroy()
		end)
		return
	end

	local outroTweens: { Tween } = buildOutroTweens(notification, texts, images, backgrounds, strokes, endPosition)

	playAndDestroyTweens(outroTweens)

	if cancelled or not notification.Parent then
		pcall(function(): ()
			notification:Destroy()
		end)
		return
	end

	pcall(function(): ()
		notification:Destroy()
	end)
end

local function processQueue(expectedToken: number): ()
	if isProcessing then
		return
	end
	isProcessing = true
	while #queue > 0 and queueToken == expectedToken do
		local item: QueueItem? = table.remove(queue, 1)
		if item then
			displayNotification(item.kind, item.text)
		end
	end
	if queueToken == expectedToken then
		isProcessing = false
	end
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
	task.spawn(processQueue, queueToken)
end

local function clearOverlay(): ()
	queueToken += 1
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

table.insert(activeConnections, importantNotificationEvent.OnClientEvent:Connect(function(kind: any, text: any): ()
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
end))

table.insert(activeConnections, player.CharacterAdded:Connect(function(_character: Model): ()
	clearOverlay()
end))

script.Destroying:Connect(function(): ()
	clearOverlay()
	for _: number, connection: RBXScriptConnection in ipairs(activeConnections) do
		connection:Disconnect()
	end
	table.clear(activeConnections)
end)`,

        'readme.md': `## 📁 Project Structure

\`\`\`
ServerScriptService/
└── ImportantNotificationBootstrap ← Script

ServerScriptService/
└── NotificationsAndPopups
    └── ImportantNotifications
        └── NotificationController ← Local script
\`\`\``
      }
    },

    cooking: {
      name: 'Cooking system',
      files: {
        'CraftingHandler.lua': `--!strict

local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local TweenService = game:GetService("TweenService")

local activeTweens: {[Instance]: {Tween}} = setmetatable({}, {__mode = "k"}) :: any

local function cancelActiveTweens(inst: Instance)
	local existing = activeTweens[inst]
	if existing then
		for _, tw in existing do
			tw:Cancel()
		end
	end
	activeTweens[inst] = nil
end

type ConfigType = {
	DEBOUNCE_DURATION: number,
	WAIT_TIMEOUT: number,
	PROMPT_MAX_DISTANCE: number,
	PROP_RESPAWN_DELAY: number,
	FADE_IN_TIME: number,
	FADE_OUT_TIME: number,
	FADE_BUFFER: number,
	TOOLS_FOLDER_NAME: string,
	PLACED_POT_PREFIX: string,
	TOOL_MIXING_POT: string,
	TOOL_TAB_BINDER: string,
	TOOL_ENERGY_EXTRACT: string,
	TOOL_INGREDIENTS: string,
	TOOL_PILLS: string,
	WORLD_MIXING_POT: string,
	WORLD_TAB_BINDER: string,
	WORLD_ENERGY_EXTRACT: string,
	WORLD_TABLE: string,
	WORLD_POT_SLOT: string,
	WORLD_PILLS_PRESS: string,
	PROMPT_ADD_TEXT: string,
	PROMPT_COLLECT_TEXT: string,
	PROMPT_POT_OBJECT_TEXT: string,
}

local cfgInst = ReplicatedStorage:WaitForChild("GameConfig")
assert(cfgInst and cfgInst:IsA("ModuleScript"), "GameConfig must be ModuleScript")
local Config = require(cfgInst) :: ConfigType

type IngredientFlags = { TabBinder: boolean, EnergyExtract: boolean }

type CraftState = {
	potOnTable: boolean,
	placedModel: Model?,
	placedPrompt: ProximityPrompt?,
	ingredients: IngredientFlags,
	readyToCollect: boolean,
	charConnections: {RBXScriptConnection},
	pendingTools: {string},
}

type PropEntry = {
	toolName: string,
	spawnCFrame: CFrame,
	template: Instance,
	available: boolean,
	live: Instance?,
	conn: RBXScriptConnection?,
}

local craftStates: {[number]: CraftState} = {}
local debounce: {[number]: boolean} = {}
local propRegistry: {[string]: PropEntry} = {}

local function requireFolder(parent: Instance, name: string): Folder
	local inst = parent:WaitForChild(name, Config.WAIT_TIMEOUT)
	assert(inst and inst:IsA("Folder"), name .. " must be Folder")
	return inst
end

local function requireModel(parent: Instance, name: string): Model
	local inst = parent:WaitForChild(name, Config.WAIT_TIMEOUT)
	assert(inst and inst:IsA("Model"), name .. " must be Model")
	return inst
end

local function requirePart(parent: Instance, name: string): BasePart
	local inst = parent:WaitForChild(name, Config.WAIT_TIMEOUT)
	assert(inst and inst:IsA("BasePart"), name .. " must be BasePart")
	return inst
end

local function getDirectPrompt(parent: Instance): ProximityPrompt
	local p = parent:FindFirstChildOfClass("ProximityPrompt")
	assert(p, parent.Name .. " missing direct ProximityPrompt")
	return p
end

local function getDeepPrompt(parent: Instance): ProximityPrompt
	local p = parent:FindFirstChildWhichIsA("ProximityPrompt", true)
	assert(p, parent.Name .. " missing ProximityPrompt")
	return p
end

local function ensurePrimaryPart(model: Model)
	if model.PrimaryPart then return end
	local part = model:FindFirstChildWhichIsA("BasePart")
	if part then model.PrimaryPart = part end
end

local function anchorDescendants(inst: Instance)
	if inst:IsA("BasePart") then
		inst.Anchored = true
		inst.CanCollide = true
	end
	for _, desc in inst:GetDescendants() do
		if desc:IsA("BasePart") then
			desc.Anchored = true
			desc.CanCollide = true
		end
	end
end

local function getInstanceCFrame(inst: Instance): CFrame
	if inst:IsA("BasePart") then
		return inst.CFrame
	elseif inst:IsA("Model") then
		if inst.PrimaryPart then return inst.PrimaryPart.CFrame end
		local firstPart = inst:FindFirstChildWhichIsA("BasePart")
		if firstPart then return firstPart.CFrame end
	end
	return CFrame.new()
end

local function placeInstance(inst: Instance, cf: CFrame)
	if inst:IsA("BasePart") then
		inst.CFrame = cf
	elseif inst:IsA("Model") then
		ensurePrimaryPart(inst)
		if inst.PrimaryPart then inst:PivotTo(cf) end
	end
end

local function setAllTransparency(inst: Instance, t: number)
	if inst:IsA("BasePart") or inst:IsA("Decal") or inst:IsA("Texture") then 
		(inst :: any).Transparency = t 
	end
	for _, desc in inst:GetDescendants() do
		if desc:IsA("BasePart") or desc:IsA("Decal") or desc:IsA("Texture") then 
			(desc :: any).Transparency = t 
		end
	end
end

local function fadeIn(inst: Instance)
	cancelActiveTweens(inst)
	local info = TweenInfo.new(Config.FADE_IN_TIME, Enum.EasingStyle.Quad, Enum.EasingDirection.Out)
	local tweens: {Tween} = {}

	local function applyTween(obj: Instance)
		if obj:IsA("BasePart") or obj:IsA("Decal") or obj:IsA("Texture") then
			local tw = TweenService:Create(obj :: any, info, { Transparency = 0 })
			table.insert(tweens, tw)
			tw:Play()
		end
	end

	applyTween(inst)
	for _, desc in inst:GetDescendants() do
		applyTween(desc)
	end

	activeTweens[inst] = tweens
	task.delay(Config.FADE_IN_TIME + Config.FADE_BUFFER, function()
		if activeTweens[inst] == tweens then activeTweens[inst] = nil end
		for _, tw in tweens do tw:Destroy() end
	end)
end

local function fadeOutAndDestroy(inst: Instance)
	cancelActiveTweens(inst)
	local info = TweenInfo.new(Config.FADE_OUT_TIME, Enum.EasingStyle.Quad, Enum.EasingDirection.In)
	local tweens: {Tween} = {}

	local function process(obj: Instance)
		if obj:IsA("ProximityPrompt") then
			obj.Enabled = false
		elseif obj:IsA("BasePart") or obj:IsA("Decal") or obj:IsA("Texture") then
			local tw = TweenService:Create(obj :: any, info, { Transparency = 1 })
			table.insert(tweens, tw)
			tw:Play()
		end
	end

	process(inst)
	for _, desc in inst:GetDescendants() do
		process(desc)
	end

	activeTweens[inst] = tweens
	task.delay(Config.FADE_OUT_TIME + Config.FADE_BUFFER, function()
		if activeTweens[inst] == tweens then activeTweens[inst] = nil end
		for _, tw in tweens do tw:Destroy() end
		if inst.Parent then inst:Destroy() end
	end)
end

local toolsFolder = requireFolder(ReplicatedStorage, Config.TOOLS_FOLDER_NAME)

local function giveTool(player: Player, name: string)
	local tmpl = toolsFolder:FindFirstChild(name)
	if not tmpl or not tmpl:IsA("Tool") then
		warn("CraftingHandler: tool template missing for '" .. name .. "'")
		return
	end
	local bp = player:FindFirstChildOfClass("Backpack")
	if not bp then return end
	local clone = tmpl:Clone()
	clone.CanBeDropped = false
	for _, desc in clone:GetDescendants() do
		if desc:IsA("BasePart") then
			desc.CanCollide = false
			desc.Massless = true
			desc.Anchored = (desc.Name ~= "Handle")
		end
	end
	clone.Parent = bp
end

local tableModel = requireModel(workspace, Config.WORLD_TABLE)
local potSlot = requirePart(tableModel, Config.WORLD_POT_SLOT)
local potSlotPrompt = getDirectPrompt(potSlot)
local pillsPressModel = requireModel(workspace, Config.WORLD_PILLS_PRESS)
local pillsPressPrompt = getDeepPrompt(pillsPressModel)
local worldMixingPot = requireModel(workspace, Config.WORLD_MIXING_POT)
local worldTabBinder = requireModel(workspace, Config.WORLD_TAB_BINDER)
local worldEnergyExtract = requirePart(workspace, Config.WORLD_ENERGY_EXTRACT)

ensurePrimaryPart(worldMixingPot)
ensurePrimaryPart(worldTabBinder)

local function getState(userId: number): CraftState
	local existing = craftStates[userId]
	if existing then return existing end
	local fresh: CraftState = {
		potOnTable = false,
		placedModel = nil,
		placedPrompt = nil,
		ingredients = { TabBinder = false, EnergyExtract = false },
		readyToCollect = false,
		charConnections = {},
		pendingTools = {},
	}
	craftStates[userId] = fresh
	return fresh
end

local function debounced(userId: number, fn: () -> ())
	if debounce[userId] then return end
	debounce[userId] = true
	local ok, errVal = pcall(fn)
	task.delay(Config.DEBOUNCE_DURATION, function()
		debounce[userId] = nil
	end)
	if not ok then
		warn("CraftingHandler [" .. userId .. "]: " .. tostring(errVal))
	end
end

local function removeTool(player: Player, name: string)
	local char = player.Character
	local bp = player:FindFirstChildOfClass("Backpack")
	if char then
		local t = char:FindFirstChild(name)
		if t and t:IsA("Tool") then t:Destroy() return end
	end
	if bp then
		local t = bp:FindFirstChild(name)
		if t and t:IsA("Tool") then t:Destroy() end
	end
end

local function equippedToolName(player: Player): string?
	local char = player.Character
	if not char then return nil end
	local t = char:FindFirstChildWhichIsA("Tool")
	return if t then t.Name else nil
end

local function recheckPillsPress()
	for _, player in Players:GetPlayers() do
		if equippedToolName(player) == Config.TOOL_INGREDIENTS then
			pillsPressPrompt.Enabled = true
			return
		end
	end
	pillsPressPrompt.Enabled = false
end

local function recheckPotSlot()
	for _, pl in Players:GetPlayers() do
		if equippedToolName(pl) == Config.TOOL_MIXING_POT then
			local st = craftStates[pl.UserId]
			if not st or not st.potOnTable then
				potSlotPrompt.Enabled = true
				return
			end
		end
	end
	potSlotPrompt.Enabled = false
end

local function resetCraftState(player: Player)
	local state = getState(player.UserId)
	if not state.potOnTable then return end
	local placed = state.placedModel
	state.potOnTable = false
	state.placedModel = nil
	state.placedPrompt = nil
	state.ingredients = { TabBinder = false, EnergyExtract = false }
	state.readyToCollect = false
	if placed then fadeOutAndDestroy(placed) end
	recheckPotSlot()
	recheckPillsPress()
end

local spawnProp: (string) -> ()

local function connectPropTrigger(entry: PropEntry)
	local inst = entry.live
	if not inst then return end
	local prompt = inst:FindFirstChildWhichIsA("ProximityPrompt", true)
	if not prompt then return end

	entry.conn = prompt.Triggered:Connect(function(player: Player)
		if not entry.available then return end
		debounced(player.UserId, function()
			if not entry.available then return end
			entry.available = false
			if entry.conn then
				entry.conn:Disconnect()
				entry.conn = nil
			end
			local live = entry.live
			if live then
				entry.live = nil
				fadeOutAndDestroy(live)
			end
			giveTool(player, entry.toolName)
			task.delay(Config.PROP_RESPAWN_DELAY, function()
				spawnProp(entry.toolName)
			end)
		end)
	end)
end

function spawnProp(toolName: string)
	local entry = propRegistry[toolName]
	if not entry then return end
	local newInst = entry.template:Clone()
	anchorDescendants(newInst)
	setAllTransparency(newInst, 1)
	newInst.Parent = workspace
	placeInstance(newInst, entry.spawnCFrame)
	entry.live = newInst
	entry.available = true
	connectPropTrigger(entry)
	fadeIn(newInst)
end

local function prewarmProp(entry: PropEntry)
	task.spawn(function()
		local clone = entry.template:Clone()
		if clone:IsA("Model") then
			ensurePrimaryPart(clone)
		end
		anchorDescendants(clone)
		setAllTransparency(clone, 1)
		clone.Parent = workspace
		placeInstance(clone, CFrame.new(0, -500, 0))
		task.wait()
		clone:Destroy()
	end)
end

local function registerProp(inst: Instance, toolName: string)
	if inst:IsA("Model") then ensurePrimaryPart(inst) end
	local cf = getInstanceCFrame(inst)
	local template = inst:Clone()
	local entry: PropEntry = {
		toolName = toolName,
		spawnCFrame = cf,
		template = template,
		available = true,
		live = inst,
		conn = nil,
	}
	propRegistry[toolName] = entry
	connectPropTrigger(entry)
	prewarmProp(entry)
end

local function buildPlacedPot(player: Player)
	local userId = player.UserId
	local state = getState(userId)
	if state.potOnTable then return end

	local propEntry = propRegistry[Config.TOOL_MIXING_POT]
	if not propEntry then return end

	local rawClone = propEntry.template:Clone()
	if not rawClone:IsA("Model") then rawClone:Destroy() return end
	local container = rawClone
	container.Name = Config.PLACED_POT_PREFIX .. userId

	for _, desc in container:GetDescendants() do
		if desc:IsA("BasePart") then
			desc.Anchored = true
			desc.CanCollide = true
		elseif desc:IsA("ProximityPrompt") then
			desc:Destroy()
		end
	end

	ensurePrimaryPart(container)
	local anchorPart = container.PrimaryPart

	local prompt = Instance.new("ProximityPrompt")
	prompt.ActionText = Config.PROMPT_ADD_TEXT
	prompt.ObjectText = Config.PROMPT_POT_OBJECT_TEXT
	prompt.MaxActivationDistance = Config.PROMPT_MAX_DISTANCE
	prompt.RequiresLineOfSight = false
	prompt.Enabled = false
	prompt.Parent = anchorPart or container

	prompt.Triggered:Connect(function(trigPlayer: Player)
		if trigPlayer.UserId ~= userId then return end
		debounced(userId, function()
			local st = getState(userId)
			if st.readyToCollect then
				resetCraftState(trigPlayer)
				giveTool(trigPlayer, Config.TOOL_INGREDIENTS)
				return
			end
			local toolName = equippedToolName(trigPlayer)
			if toolName == Config.TOOL_TAB_BINDER and not st.ingredients.TabBinder then
				removeTool(trigPlayer, Config.TOOL_TAB_BINDER)
				st.ingredients.TabBinder = true
			elseif toolName == Config.TOOL_ENERGY_EXTRACT and not st.ingredients.EnergyExtract then
				removeTool(trigPlayer, Config.TOOL_ENERGY_EXTRACT)
				st.ingredients.EnergyExtract = true
			else
				return
			end
			
			local pp = st.placedPrompt
			if pp then pp.Enabled = false end

			if st.ingredients.TabBinder and st.ingredients.EnergyExtract then
				st.readyToCollect = true
				if pp then
					pp.ActionText = Config.PROMPT_COLLECT_TEXT
					pp.Enabled = true
				end
			end
		end)
	end)

	state.potOnTable = true
	state.placedModel = container
	state.placedPrompt = prompt

	setAllTransparency(container, 1)
	container.Parent = workspace

	if anchorPart then
		local bbCF, bbSz = container:GetBoundingBox()
		local bbBottomY = bbCF.Position.Y - bbSz.Y * 0.5
		local ppToBBBottom = anchorPart.Position.Y - bbBottomY
		local targetY = potSlot.Position.Y + potSlot.Size.Y * 0.5 + ppToBBBottom
		local ppToBBCX = anchorPart.Position.X - bbCF.Position.X
		local ppToBBCZ = anchorPart.Position.Z - bbCF.Position.Z
		local rotation = anchorPart.CFrame - anchorPart.CFrame.Position
		local targetCFrame = CFrame.new(potSlot.Position.X + ppToBBCX, targetY, potSlot.Position.Z + ppToBBCZ) * rotation
		container:PivotTo(targetCFrame)
	end

	fadeIn(container)

	local currentTool = equippedToolName(player)
	if currentTool == Config.TOOL_TAB_BINDER and not state.ingredients.TabBinder then
		prompt.Enabled = true
	elseif currentTool == Config.TOOL_ENERGY_EXTRACT and not state.ingredients.EnergyExtract then
		prompt.Enabled = true
	end
end

potSlotPrompt.Triggered:Connect(function(player: Player)
	debounced(player.UserId, function()
		if equippedToolName(player) ~= Config.TOOL_MIXING_POT then return end
		local state = getState(player.UserId)
		if state.potOnTable then return end
		removeTool(player, Config.TOOL_MIXING_POT)
		potSlotPrompt.Enabled = false
		buildPlacedPot(player)
	end)
end)

pillsPressPrompt.Triggered:Connect(function(player: Player)
	debounced(player.UserId, function()
		if equippedToolName(player) ~= Config.TOOL_INGREDIENTS then return end
		removeTool(player, Config.TOOL_INGREDIENTS)
		giveTool(player, Config.TOOL_PILLS)
		recheckPillsPress()
	end)
end)

local function setupCharacter(player: Player, character: Model)
	local userId = player.UserId
	local state = getState(userId)
	for _, c in state.charConnections do c:Disconnect() end
	table.clear(state.charConnections)

	local addedConn = character.ChildAdded:Connect(function(child: Instance)
		if not child:IsA("Tool") then return end
		local name = child.Name
		local st = getState(userId)
		if name == Config.TOOL_MIXING_POT and not st.potOnTable then
			potSlotPrompt.Enabled = true
		elseif (name == Config.TOOL_TAB_BINDER or name == Config.TOOL_ENERGY_EXTRACT) and st.potOnTable and not st.readyToCollect then
			local pr = st.placedPrompt
			if pr then
				if name == Config.TOOL_TAB_BINDER and not st.ingredients.TabBinder then
					pr.Enabled = true
				elseif name == Config.TOOL_ENERGY_EXTRACT and not st.ingredients.EnergyExtract then
					pr.Enabled = true
				end
			end
		elseif name == Config.TOOL_INGREDIENTS then
			pillsPressPrompt.Enabled = true
		end
	end)

	local removedConn = character.ChildRemoved:Connect(function(child: Instance)
		if not child:IsA("Tool") then return end
		local name = child.Name
		local st = getState(userId)
		if name == Config.TOOL_MIXING_POT and not st.potOnTable then
			potSlotPrompt.Enabled = false
		elseif (name == Config.TOOL_TAB_BINDER or name == Config.TOOL_ENERGY_EXTRACT) and st.potOnTable and not st.readyToCollect then
			local pr = st.placedPrompt
			if pr then pr.Enabled = false end
		elseif name == Config.TOOL_INGREDIENTS then
			recheckPillsPress()
		end
	end)

	table.insert(state.charConnections, addedConn)
	table.insert(state.charConnections, removedConn)
end

local function setupPlayer(player: Player)
	player.CharacterRemoving:Connect(function()
		local state = getState(player.UserId)
		local saved: {string} = {}
		local bp = player:FindFirstChildOfClass("Backpack")
		if bp then
			for _, child in bp:GetChildren() do
				if child:IsA("Tool") then
					table.insert(saved, child.Name)
				end
			end
		end
		local char = player.Character
		if char then
			local equipped = char:FindFirstChildWhichIsA("Tool")
			if equipped then
				table.insert(saved, equipped.Name)
			end
		end
		state.pendingTools = saved
	end)

	player.CharacterAdded:Connect(function(character: Model)
		resetCraftState(player)
		setupCharacter(player, character)
		local state = getState(player.UserId)
		local tools = state.pendingTools
		state.pendingTools = {}
		task.defer(function()
			if not player.Parent then return end
			for _, toolName in tools do
				giveTool(player, toolName)
			end
		end)
	end)

	local existingChar = player.Character
	if existingChar then
		setupCharacter(player, existingChar)
	end
end

for _, player in Players:GetPlayers() do
	setupPlayer(player)
end
Players.PlayerAdded:Connect(setupPlayer)

Players.PlayerRemoving:Connect(function(player: Player)
	local state = craftStates[player.UserId]
	if state then
		for _, c in state.charConnections do c:Disconnect() end
		if state.placedModel then state.placedModel:Destroy() end
	end
	craftStates[player.UserId] = nil
	debounce[player.UserId] = nil
	recheckPotSlot()
end)

registerProp(worldMixingPot, Config.TOOL_MIXING_POT)
registerProp(worldTabBinder, Config.TOOL_TAB_BINDER)
registerProp(worldEnergyExtract, Config.TOOL_ENERGY_EXTRACT)`,

        'GameConfig.lua': `--!strict

export type ConfigType = {
	DEBOUNCE_DURATION: number,
	WAIT_TIMEOUT: number,
	PROMPT_MAX_DISTANCE: number,
	PROP_RESPAWN_DELAY: number,
	FADE_IN_TIME: number,
	FADE_OUT_TIME: number,
	FADE_BUFFER: number,
	TOOLS_FOLDER_NAME: string,
	PLACED_POT_PREFIX: string,
	TOOL_MIXING_POT: string,
	TOOL_TAB_BINDER: string,
	TOOL_ENERGY_EXTRACT: string,
	TOOL_INGREDIENTS: string,
	TOOL_PILLS: string,
	WORLD_MIXING_POT: string,
	WORLD_TAB_BINDER: string,
	WORLD_ENERGY_EXTRACT: string,
	WORLD_TABLE: string,
	WORLD_POT_SLOT: string,
	WORLD_PILLS_PRESS: string,
	PROMPT_ADD_TEXT: string,
	PROMPT_COLLECT_TEXT: string,
	PROMPT_POT_OBJECT_TEXT: string,
}

local Config: ConfigType = {
	DEBOUNCE_DURATION    = 0.4,
	WAIT_TIMEOUT         = 10,
	PROMPT_MAX_DISTANCE  = 8,
	PROP_RESPAWN_DELAY   = 30,
	FADE_IN_TIME         = 0.25,
	FADE_OUT_TIME        = 0.2,
	FADE_BUFFER          = 0.05,

	TOOLS_FOLDER_NAME    = "Tools",
	PLACED_POT_PREFIX    = "PlacedMixingPot_",

	TOOL_MIXING_POT      = "MixingPot",
	TOOL_TAB_BINDER      = "TabBinder",
	TOOL_ENERGY_EXTRACT  = "EnergyExtract",
	TOOL_INGREDIENTS     = "Ingredients",
	TOOL_PILLS           = "Pills",

	WORLD_MIXING_POT     = "MixingPot",
	WORLD_TAB_BINDER     = "TabBinder",
	WORLD_ENERGY_EXTRACT = "EnergyExtract",
	WORLD_TABLE          = "Table",
	WORLD_POT_SLOT       = "PotSlot",
	WORLD_PILLS_PRESS    = "PillsPress",

	PROMPT_ADD_TEXT        = "Add Ingredient",
	PROMPT_COLLECT_TEXT    = "Collect",
	PROMPT_POT_OBJECT_TEXT = "Mixing Pot",
}

return Config`,

        'MixingPotWeldScript.lua': `--!strict

local tool = script.Parent
assert(tool and tool:IsA("Tool"), "Parent must be Tool")

local handle = tool:WaitForChild("Handle", 5)
assert(handle and handle:IsA("BasePart"), tool.Name .. "/Handle must be BasePart")

for _, part in tool:GetDescendants() do
	if part:IsA("BasePart") and part ~= handle then
		local weld = Instance.new("WeldConstraint")
		weld.Part0 = handle
		weld.Part1 = part
		weld.Parent = handle
		part.Anchored = false
	end
end
`,

        'TabBinderWeldScript.lua': `--!strict

local tool = script.Parent
assert(tool and tool:IsA("Tool"), "Parent must be Tool")

local handle = tool:WaitForChild("Handle", 5)
assert(handle and handle:IsA("BasePart"), tool.Name .. "/Handle must be BasePart")

for _, part in tool:GetDescendants() do
	if part:IsA("BasePart") and part ~= handle then
		local weld = Instance.new("WeldConstraint")
		weld.Part0 = handle
		weld.Part1 = part
		weld.Parent = handle
		part.Anchored = false
	end
end
`,

        'readme.md': `## 📁 Project Structure

\`\`\`
ReplicatedStorage/
├── RemoteEvents/
│   ├── AddIngredientToPot
│   ├── PlacePotOnTable
│   ├── PressPills
│   └── TakeIngredients
│
├── Tools/
│   ├── EnergyExtract/
│   ├── Ingredients/
│   ├── MixingPot/
│   │   └── WeldScript          ← Script
│   ├── Pills/
│   └── abBinder/
│       └── WeldScript          ← Script
│
└── GameConfig                  ← ModuleScript

ServerScriptService/
└── CraftingHandler             ← Script`
      }
    },
    'drag-throw': {
      name: 'Dead Rails — drag, weight & throw',
      files: {
        'DragServer.lua': `--!strict

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
local eDragDenied = remotes:WaitForChild("DragDenied") :: RemoteEvent

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

eDragDenied.OnClientEvent:Connect(function()
	if not isDragging then return end
	isDragging = false
	throwSamples = {}
	rayParams.FilterDescendantsInstances = { character :: Instance }
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

        'DragClient.lua': `--!strict

local CollectionService = game:GetService("CollectionService")
local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local RunService = game:GetService("RunService")
local UserInputService = game:GetService("UserInputService")

local GameConfig = ReplicatedStorage:WaitForChild("GameConfig") :: ModuleScript
local Config = require(GameConfig)

type ThrowSample = {
	time: number,
	position: Vector3,
}

local camera: Camera = workspace.CurrentCamera
local localPlayer: Player = Players.LocalPlayer
local character: Model = (localPlayer.Character or localPlayer.CharacterAdded:Wait()) :: Model

local dragAttName: string = Config.AttachmentPrefix .. tostring(localPlayer.UserId)
local dragAttachment: Attachment = workspace.Terrain:WaitForChild(dragAttName) :: Attachment

local remotes: Folder = ReplicatedStorage:WaitForChild("Remotes") :: Folder
local eDragStart: RemoteEvent = remotes:WaitForChild("DragStart") :: RemoteEvent
local eDragEnd: RemoteEvent = remotes:WaitForChild("DragEnd") :: RemoteEvent

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
	local velocity: Vector3 = (newest.position - oldest.position) / dt
	if velocity.Magnitude ~= velocity.Magnitude then return nil end
	return velocity
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
	local target: BasePart? = hoveredPart
	hoveredPart = nil
	setHighlight(nil)
	rayParams.FilterDescendantsInstances = { character :: Instance }
	local velocity: Vector3? = consumeThrowVelocity()
	if target ~= nil and target.Parent ~= nil then
		eDragEnd:FireServer(velocity)
	else
		eDragEnd:FireServer(nil)
	end
end)

RunService.RenderStepped:Connect(function(_dt: number)
	if isDragging then
		if hoveredPart == nil or hoveredPart.Parent == nil then
			isDragging = false
			hoveredPart = nil
			setHighlight(nil)
			throwSamples = {}
			eDragEnd:FireServer(nil)
			rayParams.FilterDescendantsInstances = { character :: Instance }
			return
		end
		
		dragAttachment.CFrame = computeTargetCFrame()
		sampleThrow(os.clock())
		return
	end
	local newHover: BasePart? = getHoveredPart()
	if newHover ~= hoveredPart then
		hoveredPart = newHover
		setHighlight(hoveredPart)
	end
end)`,

        'CrosshairController.lua': `--!strict

local GuiService = game:GetService("GuiService")
local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local UserInputService = game:GetService("UserInputService")

local Config = require(ReplicatedStorage.GameConfig)

local localPlayer: Player = Players.LocalPlayer
local playerGui: PlayerGui = localPlayer.PlayerGui

local screenGui = Instance.new("ScreenGui")
screenGui.Name = "CrosshairGui"
screenGui.ResetOnSpawn = false
screenGui.IgnoreGuiInset = true
screenGui.Parent = playerGui

local dot = Instance.new("Frame")
dot.Name = "Dot"
dot.AnchorPoint = Vector2.new(0.5, 0.5)
dot.Position = UDim2.fromScale(0.5, 0.5)
dot.Size = UDim2.fromOffset(Config.CrosshairSize, Config.CrosshairSize)
dot.BackgroundColor3 = Config.CrosshairColor
dot.BorderSizePixel = 0
dot.Parent = screenGui

local corner = Instance.new("UICorner")
corner.CornerRadius = UDim.new(1, 0)
corner.Parent = dot

local function setCrosshairVisible(visible: boolean): ()
	screenGui.Enabled = visible
	UserInputService.MouseIconEnabled = not visible
end

setCrosshairVisible(not GuiService.MenuIsOpen)

GuiService.MenuOpened:Connect(function()
	setCrosshairVisible(false)
end)

GuiService.MenuClosed:Connect(function()
	setCrosshairVisible(true)
end)
`,

        'FirstPersonLock.lua': `--!strict

local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")

local Config = require(ReplicatedStorage.GameConfig)

local localPlayer: Player = Players.LocalPlayer
local camera: Camera = workspace.CurrentCamera

local function enforceCameraMode(): ()
	if localPlayer.CameraMode ~= Config.CameraMode then
		localPlayer.CameraMode = Config.CameraMode
	end
end

local function enforceFieldOfView(): ()
	if camera.FieldOfView ~= Config.FirstPersonFieldOfView then
		camera.FieldOfView = Config.FirstPersonFieldOfView
	end
end

enforceCameraMode()
enforceFieldOfView()

localPlayer:GetPropertyChangedSignal("CameraMode"):Connect(enforceCameraMode)
camera:GetPropertyChangedSignal("FieldOfView"):Connect(enforceFieldOfView)`,

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
Config.LightWeightColor = Color3.fromRGB(34, 255, 0)
Config.HeavyWeightColor = Color3.fromRGB(255, 0, 0)

Config.CameraMode = Enum.CameraMode.LockFirstPerson
Config.FirstPersonFieldOfView = 100

Config.CrosshairColor = Color3.fromRGB(255, 255, 255)
Config.CrosshairSize = 4

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

return Config`,

        'readme.md': `## 📁 Project Structure

\`\`\`text
ReplicatedStorage/
└── Remotes/
    ├── DragEnd
    ├── DragDenied
    └── DragStart

ServerScriptService/
└── DragServer                       ← Script

StarterPlayer/
└── StarterPlayerScripts/
    ├── DragClient                   ← LocalScript
    ├── CrosshairController          ← LocalScript
    └── FirstPersonLock              ← LocalScript`
      }
    },
    tink: {
      name: 'Tink',
      files: {
        'readme.md': `# TINK

A modern, strictly-typed Roblox framework — a drop-in replacement for the archived Knit.

Built with --!strict throughout. No archived dependencies. Supports Services, Controllers, RemoteSignals, UnreliableRemoteSignals, and RemoteProperties out of the box.

----------------------------------------

## INSTALLATION

### 1. FOLDER STRUCTURE

Create the following in Roblox Studio:

ReplicatedStorage/
└── Spark/          ← ModuleScript named "Spark"
    ├── Spark       ← ModuleScript (main core)
    ├── Signal      ← ModuleScript
    ├── Network     ← ModuleScript
    ├── Service     ← ModuleScript
    ├── Controller  ← ModuleScript
    └── Promise     ← ModuleScript (paste evaera/Promise lib here)

ReplicatedStorage/
└── Controllers/    ← Folder for client-side controllers

ServerScriptService/
├── Server          ← Script (entry point)
└── Services/       ← Folder for server-side services

StarterPlayer/
└── StarterPlayerScripts/
    └── Client      ← LocalScript (entry point)

### 2. PROMISE DEPENDENCY

Tink requires evaera/roblox-lua-promise.
Paste the contents of lib/init.lua into the Promise ModuleScript inside the Spark folder.

### 3. PASTE THE SCRIPTS

| File | Where |
| :--- | :--- |
| Spark.lua | ReplicatedStorage/Spark/Spark |
| Signal.lua | ReplicatedStorage/Spark/Signal |
| Network.lua | ReplicatedStorage/Spark/Network |
| Service.lua | ReplicatedStorage/Spark/Service |
| Controller.lua | ReplicatedStorage/Spark/Controller |
| Server.lua | ServerScriptService/Server (Script) |
| Client.lua | StarterPlayer/StarterPlayerScripts/Client (LocalScript) |

----------------------------------------

## USAGE

### CREATING A SERVICE (SERVER)

Place a ModuleScript inside ServerScriptService/Services/.

\`\`\`luau
--!strict
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Spark = require(ReplicatedStorage.Spark.Spark)

local PointsService = Spark.CreateService {
    Name = "PointsService",

    Client = {
        -- Method the client can invoke (returns a Promise on the client)
        GetPoints = function(self, player: Player): number
            return 100
        end,

        -- Server fires this to a specific client
        PointsChanged = Spark.CreateRemoteSignal(),

        -- Unreliable signal for high-frequency data (e.g. position updates)
        PositionSync = Spark.CreateUnreliableRemoteSignal(),

        -- Replicated value: auto-synced to all clients
        Multiplier = Spark.CreateRemoteProperty(1),
    },
}

function PointsService:OnInit()
    -- runs first, do not call other services here
end

function PointsService:OnStart()
    -- runs after all OnInit, safe to call other services
    self.Client.Multiplier:Set(2)                    -- send to all clients
    self.Client.Multiplier:SetFor(somePlayer, 5)     -- send to one client
    self.Client.PointsChanged:Fire(somePlayer, 200)  -- fire event to one client
    self.Client.PointsChanged:FireAll(200)           -- fire event to all clients
end

function PointsService:OnPlayerRemoving(player: Player)
    -- automatically called when a player leaves
end

return PointsService
\`\`\`

### CREATING A CONTROLLER (CLIENT)

Place a ModuleScript inside ReplicatedStorage/Controllers/.

\`\`\`luau
--!strict
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Spark = require(ReplicatedStorage.Spark.Spark)

local PointsController = Spark.CreateController { Name = "PointsController" }

function PointsController:OnInit()
    -- runs first
end

function PointsController:OnStart()
    local PointsService = Spark.GetService("PointsService")

    -- Call a server method (returns Promise)
    PointsService:GetPoints():andThen(function(points)
        print("My points:", points)
    end)

    -- Listen to a server signal
    PointsService.PointsChanged:Connect(function(points)
        print("Points updated:", points)
    end)

    -- Observe a replicated property (fires immediately + on every change)
    PointsService.Multiplier:Observe(function(value)
        print("Multiplier is now:", value)
    end)

    -- Get current value of a property (yields if not yet loaded)
    local current = PointsService.Multiplier:Get()
    print("Current multiplier:", current)
end

return PointsController
\`\`\`

### GETTING A SERVICE FROM ANOTHER SERVICE (SERVER)

\`\`\`luau
local OtherService = Spark.GetServerService("OtherService")
\`\`\`

### GETTING A CONTROLLER FROM ANOTHER CONTROLLER (CLIENT)

\`\`\`luau
local OtherController = Spark.GetController("OtherController")
\`\`\`

----------------------------------------

## API REFERENCE

### SPARK

| Method | Side | Description |
| :--- | :--- | :--- |
| Spark.CreateService(config) | Server | Creates and registers a service |
| Spark.CreateController(config) | Client | Creates and registers a controller |
| Spark.CreateRemoteSignal() | Server | Marker for a server↔client event |
| Spark.CreateUnreliableRemoteSignal() | Server | Same but uses UnreliableRemoteEvent |
| Spark.CreateRemoteProperty(default) | Server | Marker for a replicated value |
| Spark.AddModules(parent) | Both | Requires all ModuleScripts under a folder |
| Spark.Start() | Both | Starts the framework, returns Promise |
| Spark.OnStart() | Both | Returns the startup Promise |
| Spark.GetService(name) | Client | Returns a client proxy for a service |
| Spark.GetController(name) | Client | Returns a controller |
| Spark.GetServerService(name) | Server | Returns a service from the server |

### REMOTESIGNAL (SERVER-SIDE)

| Method | Description |
| :--- | :--- |
| :Fire(player, ...) | Fire to one client |
| :FireAll(...) | Fire to all clients |
| :FireExcept(player, ...) | Fire to all clients except one |
| :Connect(fn) | Listen for client→server fires |
| :Destroy() | Clean up |

### REMOTEPROPERTY (SERVER-SIDE)

| Method | Description |
| :--- | :--- |
| :Set(value) | Set for all clients without a per-player override |
| :SetFor(player, value) | Set for one client specifically |
| :SetFilter(predicate, value) | Set for clients matching a predicate |
| :Get() | Get the global value |
| :GetFor(player) | Get the value for a specific player |
| :Destroy() | Clean up |

### REMOTEPROPERTY PROXY (CLIENT-SIDE)

| Method | Description |
| :--- | :--- |
| :Get() | Returns current value (yields until loaded) |
| :Observe(fn) | Fires immediately with current value, then on every change |
| :Destroy() | Clean up |

### SIGNAL (SPARK.UTIL.SIGNAL)

| Method | Description |
| :--- | :--- |
| Signal.new() | Create a new signal |
| :Connect(fn) | Subscribe |
| :Once(fn) | Subscribe for one fire only |
| :Wait() | Yield until next fire |
| :Fire(...) | Fire all listeners |
| :DisconnectAll() | Remove all connections |
| :Destroy() | Clean up |

----------------------------------------

## LIFECYCLE

\`\`\`
Server                              Client
──────────────────────────────      ──────────────────────────────
AddModules (loads all services)     AddModules (loads all controllers)
         ↓                                      ↓
   _bindClient (creates remotes)         WaitForReady
         ↓                                      ↓
   CreateReadyMarker                   OnInit (all controllers)
         ↓                                      ↓
   OnInit (all services)             OnStart (all controllers)
         ↓
   OnStart (all services)
\`\`\`

* **OnInit** — setup only, do not call other services/controllers here. Can optionally return a Promise to delay the next lifecycle stage.
* **OnStart** — everything is ready, call freely. Can optionally return a Promise.

----------------------------------------

## LICENSE

MIT`,

        'Client.luau': `--!strict
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Spark = require(ReplicatedStorage:WaitForChild("Spark"):WaitForChild("Spark"))

Spark.AddModules(ReplicatedStorage:WaitForChild("Controllers"))

Spark.Start():andThen(function()
    print("[Spark] Client started")
end):catch(function(err: any)
    warn("[Spark] Client startup error: " .. tostring(err))
end)`,

        'Controller.luau': `--!strict
export type ControllerConfig = {
    Name: string,
    [string]: any,
}

export type Controller = {
    Name: string,
    [string]: any,
}

local ControllerModule = {}
local createdControllers: { [string]: Controller } = {}
local startupLocked: boolean = false

function ControllerModule._lock(): ()
    startupLocked = true
end

function ControllerModule._getAll(): { [string]: Controller }
    return createdControllers
end

function ControllerModule.CreateController(config: ControllerConfig): Controller
    assert(not startupLocked, "[Spark.Controller] Cannot create a Controller after Spark.Start()")
    assert(type(config) == "table", "[Spark.Controller] CreateController expects a table")
    assert(
        type(config.Name) == "string" and config.Name ~= "",
        "[Spark.Controller] Controller requires a non-empty Name"
    )
    assert(createdControllers[config.Name] == nil, "[Spark.Controller] Duplicate Controller name: " .. config.Name)

    local controller: Controller = config :: any
    createdControllers[config.Name] = controller

    return controller
end

return ControllerModule`,

        'Network.luau': `--!strict
local RunService = game:GetService("RunService")
local ReplicatedStorage = game:GetService("ReplicatedStorage")

local IS_SERVER: boolean = RunService:IsServer()
local FOLDER_NAME: string = "SparkRemotes"
local READY_MARKER: string = "__spark_ready__"

local cachedFolder: Folder? = nil
local eventCache: { [string]: RemoteEvent } = {}
local functionCache: { [string]: RemoteFunction } = {}
local unreliableCache: { [string]: UnreliableRemoteEvent } = {}
local propEventCache: { [string]: RemoteEvent } = {}
local propFunctionCache: { [string]: RemoteFunction } = {}

local Network = {}

local function getFolder(): Folder
    local cached = cachedFolder
    if cached ~= nil then
        return cached
    end

    if IS_SERVER then
        local existing = ReplicatedStorage:FindFirstChild(FOLDER_NAME)
        if existing ~= nil and existing:IsA("Folder") then
            cachedFolder = existing
            return existing
        end

        local created = Instance.new("Folder")
        created.Name = FOLDER_NAME
        created.Parent = ReplicatedStorage
        cachedFolder = created
        return created
    end

    local found = ReplicatedStorage:WaitForChild(FOLDER_NAME, 60)
    assert(found ~= nil and found:IsA("Folder"), "[Spark.Network] SparkRemotes did not replicate in time")
    local folder = found :: Folder
    cachedFolder = folder
    return folder
end

local function buildKey(service: string, member: string, kind: string): string
    return service .. "/" .. member .. "/" .. kind
end

local function getRemoteEvent(service: string, member: string): RemoteEvent
    local key = buildKey(service, member, "RE")
    local cached = eventCache[key]
    if cached ~= nil then
        return cached
    end

    local folder = getFolder()
    if IS_SERVER then
        local existing = folder:FindFirstChild(key)
        if existing ~= nil and existing:IsA("RemoteEvent") then
            eventCache[key] = existing
            return existing
        end

        local remote = Instance.new("RemoteEvent")
        remote.Name = key
        remote.Parent = folder
        eventCache[key] = remote
        return remote
    end

    local found = folder:WaitForChild(key, 60)
    assert(found ~= nil and found:IsA("RemoteEvent"), "[Spark.Network] RemoteEvent not found: " .. key)
    local remote = found :: RemoteEvent
    eventCache[key] = remote
    return remote
end

Network.GetRemoteEvent = getRemoteEvent

local function getRemoteFunction(service: string, member: string): RemoteFunction
    local key = buildKey(service, member, "RF")
    local cached = functionCache[key]
    if cached ~= nil then
        return cached
    end

    local folder = getFolder()
    if IS_SERVER then
        local existing = folder:FindFirstChild(key)
        if existing ~= nil and existing:IsA("RemoteFunction") then
            functionCache[key] = existing
            return existing
        end

        local remote = Instance.new("RemoteFunction")
        remote.Name = key
        remote.Parent = folder
        functionCache[key] = remote
        return remote
    end

    local found = folder:WaitForChild(key, 60)
    assert(found ~= nil and found:IsA("RemoteFunction"), "[Spark.Network] RemoteFunction not found: " .. key)
    local remote = found :: RemoteFunction
    functionCache[key] = remote
    return remote
end

Network.GetRemoteFunction = getRemoteFunction

local function getUnreliableRemoteEvent(service: string, member: string): UnreliableRemoteEvent
    local key = buildKey(service, member, "URE")
    local cached = unreliableCache[key]
    if cached ~= nil then
        return cached
    end

    local folder = getFolder()
    if IS_SERVER then
        local existing = folder:FindFirstChild(key)
        if existing ~= nil and existing:IsA("UnreliableRemoteEvent") then
            unreliableCache[key] = existing
            return existing
        end

        local remote = Instance.new("UnreliableRemoteEvent")
        remote.Name = key
        remote.Parent = folder
        unreliableCache[key] = remote
        return remote
    end

    local found = folder:WaitForChild(key, 60)
    assert(found ~= nil and found:IsA("UnreliableRemoteEvent"), "[Spark.Network] UnreliableRemoteEvent not found: " .. key)
    local remote = found :: UnreliableRemoteEvent
    unreliableCache[key] = remote
    return remote
end

Network.GetUnreliableRemoteEvent = getUnreliableRemoteEvent

local function getPropertyUpdateEvent(service: string, member: string): RemoteEvent
    local key = buildKey(service, member, "RPE")
    local cached = propEventCache[key]
    if cached ~= nil then
        return cached
    end

    local folder = getFolder()
    if IS_SERVER then
        local existing = folder:FindFirstChild(key)
        if existing ~= nil and existing:IsA("RemoteEvent") then
            propEventCache[key] = existing
            return existing
        end

        local remote = Instance.new("RemoteEvent")
        remote.Name = key
        remote.Parent = folder
        propEventCache[key] = remote
        return remote
    end

    local found = folder:WaitForChild(key, 60)
    assert(found ~= nil and found:IsA("RemoteEvent"), "[Spark.Network] Property update event not found: " .. key)
    local remote = found :: RemoteEvent
    propEventCache[key] = remote
    return remote
end

Network.GetPropertyUpdateEvent = getPropertyUpdateEvent

local function getPropertyInitFunction(service: string, member: string): RemoteFunction
    local key = buildKey(service, member, "RPF")
    local cached = propFunctionCache[key]
    if cached ~= nil then
        return cached
    end

    local folder = getFolder()
    if IS_SERVER then
        local existing = folder:FindFirstChild(key)
        if existing ~= nil and existing:IsA("RemoteFunction") then
            propFunctionCache[key] = existing
            return existing
        end

        local remote = Instance.new("RemoteFunction")
        remote.Name = key
        remote.Parent = folder
        propFunctionCache[key] = remote
        return remote
    end

    local found = folder:WaitForChild(key, 60)
    assert(found ~= nil and found:IsA("RemoteFunction"), "[Spark.Network] Property init function not found: " .. key)
    local remote = found :: RemoteFunction
    propFunctionCache[key] = remote
    return remote
end

Network.GetPropertyInitFunction = getPropertyInitFunction

function Network.CreateReadyMarker(): ()
    assert(IS_SERVER, "[Spark.Network] CreateReadyMarker must be called on the server")
    local folder = getFolder()
    if folder:FindFirstChild(READY_MARKER) ~= nil then
        return
    end

    local marker = Instance.new("BoolValue")
    marker.Name = READY_MARKER
    marker.Value = true
    marker.Parent = folder
end

function Network.WaitForReady(): ()
    assert(not IS_SERVER, "[Spark.Network] WaitForReady must be called on the client")
    local folder = getFolder()
    local found = folder:WaitForChild(READY_MARKER, 60)
    assert(found ~= nil, "[Spark.Network] Server did not signal ready in time")
end

return Network`,

        'Promise.luau': `-[[
	An implementation of Promises similar to Promise/A+.
]]

local ERROR_NON_PROMISE_IN_LIST = "Non-promise value passed into %s at index %s"
local ERROR_NON_LIST = "Please pass a list of promises to %s"
local ERROR_NON_FUNCTION = "Please pass a handler function to %s!"
local MODE_KEY_METATABLE = { __mode = "k" }

local function isCallable(value)
	if type(value) == "function" then
		return true
	end

	if type(value) == "table" then
		local metatable = getmetatable(value)
		if metatable and type(rawget(metatable, "__call")) == "function" then
			return true
		end
	end

	return false
end

--[[
	Creates an enum dictionary with some metamethods to prevent common mistakes.
]]
local function makeEnum(enumName, members)
	local enum = {}

	for _, memberName in ipairs(members) do
		enum[memberName] = memberName
	end

	return setmetatable(enum, {
		__index = function(_, k)
			error(string.format("%s is not in %s!", k, enumName), 2)
		end,
		__newindex = function()
			error(string.format("Creating new members in %s is not allowed!", enumName), 2)
		end,
	})
end

--[=[
	An object to represent runtime errors that occur during execution.
	Promises that experience an error like this will be rejected with
	an instance of this object.

	@class Error
]=]
local Error
do
	Error = {
		Kind = makeEnum("Promise.Error.Kind", {
			"ExecutionError",
			"AlreadyCancelled",
			"NotResolvedInTime",
			"TimedOut",
		}),
	}
	Error.__index = Error

	function Error.new(options, parent)
		options = options or {}
		return setmetatable({
			error = tostring(options.error) or "[This error has no error text.]",
			trace = options.trace,
			context = options.context,
			kind = options.kind,
			parent = parent,
			createdTick = os.clock(),
			createdTrace = debug.traceback(),
		}, Error)
	end

	function Error.is(anything)
		if type(anything) == "table" then
			local metatable = getmetatable(anything)

			if type(metatable) == "table" then
				return rawget(anything, "error") ~= nil and type(rawget(metatable, "extend")) == "function"
			end
		end

		return false
	end

	function Error.isKind(anything, kind)
		assert(kind ~= nil, "Argument #2 to Promise.Error.isKind must not be nil")

		return Error.is(anything) and anything.kind == kind
	end

	function Error:extend(options)
		options = options or {}

		options.kind = options.kind or self.kind

		return Error.new(options, self)
	end

	function Error:getErrorChain()
		local runtimeErrors = { self }

		while runtimeErrors[#runtimeErrors].parent do
			table.insert(runtimeErrors, runtimeErrors[#runtimeErrors].parent)
		end

		return runtimeErrors
	end

	function Error:__tostring()
		local errorStrings = {
			string.format("-- Promise.Error(%s) --", self.kind or "?"),
		}

		for _, runtimeError in ipairs(self:getErrorChain()) do
			table.insert(
				errorStrings,
				table.concat({
					runtimeError.trace or runtimeError.error,
					runtimeError.context,
				}, "\n")
			)
		end

		return table.concat(errorStrings, "\n")
	end
end

--[[
	Packs a number of arguments into a table and returns its length.

	Used to cajole varargs without dropping sparse values.
]]
local function pack(...)
	return select("#", ...), { ... }
end

--[[
	Returns first value (success), and packs all following values.
]]
local function packResult(success, ...)
	return success, select("#", ...), { ... }
end

local function makeErrorHandler(traceback)
	assert(traceback ~= nil, "traceback is nil")

	return function(err)
		-- If the error object is already a table, forward it directly.
		-- Should we extend the error here and add our own trace?

		if type(err) == "table" then
			return err
		end

		return Error.new({
			error = err,
			kind = Error.Kind.ExecutionError,
			trace = debug.traceback(tostring(err), 2),
			context = "Promise created at:\n\n" .. traceback,
		})
	end
end

--[[
	Calls a Promise executor with error handling.
]]
local function runExecutor(traceback, callback, ...)
	return packResult(xpcall(callback, makeErrorHandler(traceback), ...))
end

--[[
	Creates a function that invokes a callback with correct error handling and
	resolution mechanisms.
]]
local function createAdvancer(traceback, callback, resolve, reject)
	return function(...)
		local ok, resultLength, result = runExecutor(traceback, callback, ...)

		if ok then
			resolve(unpack(result, 1, resultLength))
		else
			reject(result[1])
		end
	end
end

local function isEmpty(t)
	return next(t) == nil
end

--[=[
	An enum value used to represent the Promise's status.
	@interface Status
	@tag enum
	@within Promise
	.Started "Started" -- The Promise is executing, and not settled yet.
	.Resolved "Resolved" -- The Promise finished successfully.
	.Rejected "Rejected" -- The Promise was rejected.
	.Cancelled "Cancelled" -- The Promise was cancelled before it finished.
]=]
--[=[
	@prop Status Status
	@within Promise
	@readonly
	@tag enums
	A table containing all members of the \`Status\` enum, e.g., \`Promise.Status.Resolved\`.
]=]
--[=[
	A Promise is an object that represents a value that will exist in the future, but doesn't right now.
	Promises allow you to then attach callbacks that can run once the value becomes available (known as *resolving*),
	or if an error has occurred (known as *rejecting*).

	@class Promise
	@__index prototype
]=]
local Promise = {
	Error = Error,
	Status = makeEnum("Promise.Status", { "Started", "Resolved", "Rejected", "Cancelled" }),
	_getTime = os.clock,
	_timeEvent = game:GetService("RunService").Heartbeat,
	_unhandledRejectionCallbacks = {},
}
Promise.prototype = {}
Promise.__index = Promise.prototype

function Promise._new(traceback, callback, parent)
	if parent ~= nil and not Promise.is(parent) then
		error("Argument #2 to Promise.new must be a promise or nil", 2)
	end

	local self = {
		-- The executor thread.
		_thread = nil,

		-- Used to locate where a promise was created
		_source = traceback,

		_status = Promise.Status.Started,

		-- A table containing a list of all results, whether success or failure.
		-- Only valid if _status is set to something besides Started
		_values = nil,

		-- Lua doesn't like sparse arrays very much, so we explicitly store the
		-- length of _values to handle middle nils.
		_valuesLength = -1,

		-- Tracks if this Promise has no error observers..
		_unhandledRejection = true,

		-- Queues representing functions we should invoke when we update!
		_queuedResolve = {},
		_queuedReject = {},
		_queuedFinally = {},

		-- The function to run when/if this promise is cancelled.
		_cancellationHook = nil,

		-- The "parent" of this promise in a promise chain. Required for
		-- cancellation propagation upstream.
		_parent = parent,

		-- Consumers are Promises that have chained onto this one.
		-- We track them for cancellation propagation downstream.
		_consumers = setmetatable({}, MODE_KEY_METATABLE),
	}

	if parent and parent._status == Promise.Status.Started then
		parent._consumers[self] = true
	end

	setmetatable(self, Promise)

	local function resolve(...)
		self:_resolve(...)
	end

	local function reject(...)
		self:_reject(...)
	end

	local function onCancel(cancellationHook)
		if cancellationHook then
			if self._status == Promise.Status.Cancelled then
				cancellationHook()
			else
				self._cancellationHook = cancellationHook
			end
		end

		return self._status == Promise.Status.Cancelled
	end

	self._thread = coroutine.create(function()
		local ok, _, result = runExecutor(self._source, callback, resolve, reject, onCancel)

		if not ok then
			reject(result[1])
		end
	end)

	task.spawn(self._thread)

	return self
end

--[=[
	Construct a new Promise that will be resolved or rejected with the given callbacks.

	If you \`resolve\` with a Promise, it will be chained onto.

	You can safely yield within the executor function and it will not block the creating thread.

	\`\`\`lua
	local myFunction()
		return Promise.new(function(resolve, reject, onCancel)
			wait(1)
			resolve("Hello world!")
		end)
	end

	myFunction():andThen(print)
	\`\`\`

	You do not need to use \`pcall\` within a Promise. Errors that occur during execution will be caught and turned into a rejection automatically. If \`error()\` is called with a table, that table will be the rejection value. Otherwise, string errors will be converted into \`Promise.Error(Promise.Error.Kind.ExecutionError)\` objects for tracking debug information.

	You may register an optional cancellation hook by using the \`onCancel\` argument:

	* This should be used to abort any ongoing operations leading up to the promise being settled.
	* Call the \`onCancel\` function with a function callback as its only argument to set a hook which will in turn be called when/if the promise is cancelled.
	* \`onCancel\` returns \`true\` if the Promise was already cancelled when you called \`onCancel\`.
	* Calling \`onCancel\` with no argument will not override a previously set cancellation hook, but it will still return \`true\` if the Promise is currently cancelled.
	* You can set the cancellation hook at any time before resolving.
	* When a promise is cancelled, calls to \`resolve\` or \`reject\` will be ignored, regardless of if you set a cancellation hook or not.

	:::caution
	If the Promise is cancelled, the \`executor\` thread is closed with \`coroutine.close\` after the cancellation hook is called.

	You must perform any cleanup code in the cancellation hook: any time your executor yields, it **may never resume**.
	:::

	@param executor (resolve: (...: any) -> (), reject: (...: any) -> (), onCancel: (abortHandler?: () -> ()) -> boolean) -> ()
	@return Promise
]=]
function Promise.new(executor)
	return Promise._new(debug.traceback(nil, 2), executor)
end

function Promise:__tostring()
	return string.format("Promise(%s)", self._status)
end

--[=[
	The same as [Promise.new](/api/Promise#new), except execution begins after the next \`Heartbeat\` event.

	This is a spiritual replacement for \`spawn\`, but it does not suffer from the same [issues](https://eryn.io/gist/3db84579866c099cdd5bb2ff37947cec) as \`spawn\`.

	\`\`\`lua
	local function waitForChild(instance, childName, timeout)
	  return Promise.defer(function(resolve, reject)
		local child = instance:WaitForChild(childName, timeout)

		;(child and resolve or reject)(child)
	  end)
	end
	\`\`\`

	@param executor (resolve: (...: any) -> (), reject: (...: any) -> (), onCancel: (abortHandler?: () -> ()) -> boolean) -> ()
	@return Promise
]=]
function Promise.defer(executor)
	local traceback = debug.traceback(nil, 2)
	local promise
	promise = Promise._new(traceback, function(resolve, reject, onCancel)
		task.defer(function()
			local ok, _, result = runExecutor(traceback, executor, resolve, reject, onCancel)

			if not ok then
				reject(result[1])
			end
		end)
	end)

	return promise
end

-- Backwards compatibility
Promise.async = Promise.defer

--[=[
	Creates an immediately resolved Promise with the given value.

	\`\`\`lua
	-- Example using Promise.resolve to deliver cached values:
	function getSomething(name)
		if cache[name] then
			return Promise.resolve(cache[name])
		else
			return Promise.new(function(resolve, reject)
				local thing = getTheThing()
				cache[name] = thing

				resolve(thing)
			end)
		end
	end
	\`\`\`

	@param ... any
	@return Promise<...any>
]=]
function Promise.resolve(...)
	local length, values = pack(...)
	return Promise._new(debug.traceback(nil, 2), function(resolve)
		resolve(unpack(values, 1, length))
	end)
end

--[=[
	Creates an immediately rejected Promise with the given value.

	:::caution
	Something needs to consume this rejection (i.e. \`:catch()\` it), otherwise it will emit an unhandled Promise rejection warning on the next frame. Thus, you should not create and store rejected Promises for later use. Only create them on-demand as needed.
	:::

	@param ... any
	@return Promise<...any>
]=]
function Promise.reject(...)
	local length, values = pack(...)
	return Promise._new(debug.traceback(nil, 2), function(_, reject)
		reject(unpack(values, 1, length))
	end)
end

--[[
	Runs a non-promise-returning function as a Promise with the
  given arguments.
]]
function Promise._try(traceback, callback, ...)
	local valuesLength, values = pack(...)

	return Promise._new(traceback, function(resolve)
		resolve(callback(unpack(values, 1, valuesLength)))
	end)
end

--[=[
	Begins a Promise chain, calling a function and returning a Promise resolving with its return value. If the function errors, the returned Promise will be rejected with the error. You can safely yield within the Promise.try callback.

	:::info
	\`Promise.try\` is similar to [Promise.promisify](#promisify), except the callback is invoked immediately instead of returning a new function.
	:::

	\`\`\`lua
	Promise.try(function()
		return math.random(1, 2) == 1 and "ok" or error("Oh an error!")
	end)
		:andThen(function(text)
			print(text)
		end)
		:catch(function(err)
			warn("Something went wrong")
		end)
	\`\`\`

	@param callback (...: T...) -> ...any
	@param ... T... -- Additional arguments passed to \`callback\`
	@return Promise
]=]
function Promise.try(callback, ...)
	return Promise._try(debug.traceback(nil, 2), callback, ...)
end

--[[
	Returns a new promise that:
		* is resolved when all input promises resolve
		* is rejected if ANY input promises reject
]]
function Promise._all(traceback, promises, amount)
	if type(promises) ~= "table" then
		error(string.format(ERROR_NON_LIST, "Promise.all"), 3)
	end

	-- We need to check that each value is a promise here so that we can produce
	-- a proper error rather than a rejected promise with our error.
	for i, promise in pairs(promises) do
		if not Promise.is(promise) then
			error(string.format(ERROR_NON_PROMISE_IN_LIST, "Promise.all", tostring(i)), 3)
		end
	end

	-- If there are no values then return an already resolved promise.
	if #promises == 0 or amount == 0 then
		return Promise.resolve({})
	end

	return Promise._new(traceback, function(resolve, reject, onCancel)
		-- An array to contain our resolved values from the given promises.
		local resolvedValues = {}
		local newPromises = {}

		-- Keep a count of resolved promises because just checking the resolved
		-- values length wouldn't account for promises that resolve with nil.
		local resolvedCount = 0
		local rejectedCount = 0
		local done = false

		local function cancel()
			for _, promise in ipairs(newPromises) do
				promise:cancel()
			end
		end

		-- Called when a single value is resolved and resolves if all are done.
		local function resolveOne(i, ...)
			if done then
				return
			end

			resolvedCount = resolvedCount + 1

			if amount == nil then
				resolvedValues[i] = ...
			else
				resolvedValues[resolvedCount] = ...
			end

			if resolvedCount >= (amount or #promises) then
				done = true
				resolve(resolvedValues)
				cancel()
			end
		end

		onCancel(cancel)

		-- We can assume the values inside \`promises\` are all promises since we
		-- checked above.
		for i, promise in ipairs(promises) do
			newPromises[i] = promise:andThen(function(...)
				resolveOne(i, ...)
			end, function(...)
				rejectedCount = rejectedCount + 1

				if amount == nil or #promises - rejectedCount < amount then
					cancel()
					done = true

					reject(...)
				end
			end)
		end

		if done then
			cancel()
		end
	end)
end

--[=[
	Accepts an array of Promises and returns a new promise that:
	* is resolved after all input promises resolve.
	* is rejected if *any* input promises reject.

	:::info
	Only the first return value from each promise will be present in the resulting array.
	:::

	After any input Promise rejects, all other input Promises that are still pending will be cancelled if they have no other consumers.

	\`\`\`lua
	local promises = {
		returnsAPromise("example 1"),
		returnsAPromise("example 2"),
		returnsAPromise("example 3"),
	}

	return Promise.all(promises)
	\`\`\`

	@param promises {Promise<T>}
	@return Promise<{T}>
]=]
function Promise.all(promises)
	return Promise._all(debug.traceback(nil, 2), promises)
end

--[=[
	Folds an array of values or promises into a single value. The array is traversed sequentially.

	The reducer function can return a promise or value directly. Each iteration receives the resolved value from the previous, and the first receives your defined initial value.

	The folding will stop at the first rejection encountered.
	\`\`\`lua
	local basket = {"blueberry", "melon", "pear", "melon"}
	Promise.fold(basket, function(cost, fruit)
		if fruit == "blueberry" then
			return cost -- blueberries are free!
		else
			-- call a function that returns a promise with the fruit price
			return fetchPrice(fruit):andThen(function(fruitCost)
				return cost + fruitCost
			end)
		end
	end, 0)
	\`\`\`

	@since v3.1.0
	@param list {T | Promise<T>}
	@param reducer (accumulator: U, value: T, index: number) -> U | Promise<U>
	@param initialValue U
]=]
function Promise.fold(list, reducer, initialValue)
	assert(type(list) == "table", "Bad argument #1 to Promise.fold: must be a table")
	assert(isCallable(reducer), "Bad argument #2 to Promise.fold: must be a function")

	local accumulator = Promise.resolve(initialValue)
	return Promise.each(list, function(resolvedElement, i)
		accumulator = accumulator:andThen(function(previousValueResolved)
			return reducer(previousValueResolved, resolvedElement, i)
		end)
	end):andThen(function()
		return accumulator
	end)
end

--[=[
	Accepts an array of Promises and returns a Promise that is resolved as soon as \`count\` Promises are resolved from the input array. The resolved array values are in the order that the Promises resolved in. When this Promise resolves, all other pending Promises are cancelled if they have no other consumers.

	\`count\` 0 results in an empty array. The resultant array will never have more than \`count\` elements.

	\`\`\`lua
	local promises = {
		returnsAPromise("example 1"),
		returnsAPromise("example 2"),
		returnsAPromise("example 3"),
	}

	return Promise.some(promises, 2) -- Only resolves with first 2 promises to resolve
	\`\`\`

	@param promises {Promise<T>}
	@param count number
	@return Promise<{T}>
]=]
function Promise.some(promises, count)
	assert(type(count) == "number", "Bad argument #2 to Promise.some: must be a number")

	return Promise._all(debug.traceback(nil, 2), promises, count)
end

--[=[
	Accepts an array of Promises and returns a Promise that is resolved as soon as *any* of the input Promises resolves. It will reject only if *all* input Promises reject. As soon as one Promises resolves, all other pending Promises are cancelled if they have no other consumers.

	Resolves directly with the value of the first resolved Promise. This is essentially [[Promise.some]] with \`1\` count, except the Promise resolves with the value directly instead of an array with one element.

	\`\`\`lua
	local promises = {
		returnsAPromise("example 1"),
		returnsAPromise("example 2"),
		returnsAPromise("example 3"),
	}

	return Promise.any(promises) -- Resolves with first value to resolve (only rejects if all 3 rejected)
	\`\`\`

	@param promises {Promise<T>}
	@return Promise<T>
]=]
function Promise.any(promises)
	return Promise._all(debug.traceback(nil, 2), promises, 1):andThen(function(values)
		return values[1]
	end)
end

--[=[
	Accepts an array of Promises and returns a new Promise that resolves with an array of in-place Statuses when all input Promises have settled. This is equivalent to mapping \`promise:finally\` over the array of Promises.

	\`\`\`lua
	local promises = {
		returnsAPromise("example 1"),
		returnsAPromise("example 2"),
		returnsAPromise("example 3"),
	}

	return Promise.allSettled(promises)
	\`\`\`

	@param promises {Promise<T>}
	@return Promise<{Status}>
]=]
function Promise.allSettled(promises)
	if type(promises) ~= "table" then
		error(string.format(ERROR_NON_LIST, "Promise.allSettled"), 2)
	end

	-- We need to check that each value is a promise here so that we can produce
	-- a proper error rather than a rejected promise with our error.
	for i, promise in pairs(promises) do
		if not Promise.is(promise) then
			error(string.format(ERROR_NON_PROMISE_IN_LIST, "Promise.allSettled", tostring(i)), 2)
		end
	end

	-- If there are no values then return an already resolved promise.
	if #promises == 0 then
		return Promise.resolve({})
	end

	return Promise._new(debug.traceback(nil, 2), function(resolve, _, onCancel)
		-- An array to contain our resolved values from the given promises.
		local fates = {}
		local newPromises = {}

		-- Keep a count of resolved promises because just checking the resolved
		-- values length wouldn't account for promises that resolve with nil.
		local finishedCount = 0

		-- Called when a single value is resolved and resolves if all are done.
		local function resolveOne(i, ...)
			finishedCount = finishedCount + 1

			fates[i] = ...

			if finishedCount >= #promises then
				resolve(fates)
			end
		end

		onCancel(function()
			for _, promise in ipairs(newPromises) do
				promise:cancel()
			end
		end)

		-- We can assume the values inside \`promises\` are all promises since we
		-- checked above.
		for i, promise in ipairs(promises) do
			newPromises[i] = promise:finally(function(...)
				resolveOne(i, ...)
			end)
		end
	end)
end

--[=[
	Accepts an array of Promises and returns a new promise that is resolved or rejected as soon as any Promise in the array resolves or rejects.

	:::warning
	If the first Promise to settle from the array settles with a rejection, the resulting Promise from \`race\` will reject.

	If you instead want to tolerate rejections, and only care about at least one Promise resolving, you should use [Promise.any](#any) or [Promise.some](#some) instead.
	:::

	All other Promises that don't win the race will be cancelled if they have no other consumers.

	\`\`\`lua
	local promises = {
		returnsAPromise("example 1"),
		returnsAPromise("example 2"),
		returnsAPromise("example 3"),
	}

	return Promise.race(promises) -- Only returns 1st value to resolve or reject
	\`\`\`

	@param promises {Promise<T>}
	@return Promise<T>
]=]
function Promise.race(promises)
	assert(type(promises) == "table", string.format(ERROR_NON_LIST, "Promise.race"))

	for i, promise in pairs(promises) do
		assert(Promise.is(promise), string.format(ERROR_NON_PROMISE_IN_LIST, "Promise.race", tostring(i)))
	end

	return Promise._new(debug.traceback(nil, 2), function(resolve, reject, onCancel)
		local newPromises = {}
		local finished = false

		local function cancel()
			for _, promise in ipairs(newPromises) do
				promise:cancel()
			end
		end

		local function finalize(callback)
			return function(...)
				cancel()
				finished = true
				return callback(...)
			end
		end

		if onCancel(finalize(reject)) then
			return
		end

		for i, promise in ipairs(promises) do
			newPromises[i] = promise:andThen(finalize(resolve), finalize(reject))
		end

		if finished then
			cancel()
		end
	end)
end

--[=[
	Iterates serially over the given an array of values, calling the predicate callback on each value before continuing.

	If the predicate returns a Promise, we wait for that Promise to resolve before moving on to the next item
	in the array.

	:::info
	\`Promise.each\` is similar to \`Promise.all\`, except the Promises are ran in order instead of all at once.

	But because Promises are eager, by the time they are created, they're already running. Thus, we need a way to defer creation of each Promise until a later time.

	The predicate function exists as a way for us to operate on our data instead of creating a new closure for each Promise. If you would prefer, you can pass in an array of functions, and in the predicate, call the function and return its return value.
	:::

	\`\`\`lua
	Promise.each({
		"foo",
		"bar",
		"baz",
		"qux"
	}, function(value, index)
		return Promise.delay(1):andThen(function()
		print(("%d) Got %s!"):format(index, value))
		end)
	end)

	--[[
		(1 second passes)
		> 1) Got foo!
		(1 second passes)
		> 2) Got bar!
		(1 second passes)
		> 3) Got baz!
		(1 second passes)
		> 4) Got qux!
	]]
	\`\`\`

	If the Promise a predicate returns rejects, the Promise from \`Promise.each\` is also rejected with the same value.

	If the array of values contains a Promise, when we get to that point in the list, we wait for the Promise to resolve before calling the predicate with the value.

	If a Promise in the array of values is already Rejected when \`Promise.each\` is called, \`Promise.each\` rejects with that value immediately (the predicate callback will never be called even once). If a Promise in the list is already Cancelled when \`Promise.each\` is called, \`Promise.each\` rejects with \`Promise.Error(Promise.Error.Kind.AlreadyCancelled\`). If a Promise in the array of values is Started at first, but later rejects, \`Promise.each\` will reject with that value and iteration will not continue once iteration encounters that value.

	Returns a Promise containing an array of the returned/resolved values from the predicate for each item in the array of values.

	If this Promise returned from \`Promise.each\` rejects or is cancelled for any reason, the following are true:
	- Iteration will not continue.
	- Any Promises within the array of values will now be cancelled if they have no other consumers.
	- The Promise returned from the currently active predicate will be cancelled if it hasn't resolved yet.

	@since 3.0.0
	@param list {T | Promise<T>}
	@param predicate (value: T, index: number) -> U | Promise<U>
	@return Promise<{U}>
]=]
function Promise.each(list, predicate)
	assert(type(list) == "table", string.format(ERROR_NON_LIST, "Promise.each"))
	assert(isCallable(predicate), string.format(ERROR_NON_FUNCTION, "Promise.each"))

	return Promise._new(debug.traceback(nil, 2), function(resolve, reject, onCancel)
		local results = {}
		local promisesToCancel = {}

		local cancelled = false

		local function cancel()
			for _, promiseToCancel in ipairs(promisesToCancel) do
				promiseToCancel:cancel()
			end
		end

		onCancel(function()
			cancelled = true

			cancel()
		end)

		-- We need to preprocess the list of values and look for Promises.
		-- If we find some, we must register our andThen calls now, so that those Promises have a consumer
		-- from us registered. If we don't do this, those Promises might get cancelled by something else
		-- before we get to them in the series because it's not possible to tell that we plan to use it
		-- unless we indicate it here.

		local preprocessedList = {}

		for index, value in ipairs(list) do
			if Promise.is(value) then
				if value:getStatus() == Promise.Status.Cancelled then
					cancel()
					return reject(Error.new({
						error = "Promise is cancelled",
						kind = Error.Kind.AlreadyCancelled,
						context = string.format(
							"The Promise that was part of the array at index %d passed into Promise.each was already cancelled when Promise.each began.\n\nThat Promise was created at:\n\n%s",
							index,
							value._source
						),
					}))
				elseif value:getStatus() == Promise.Status.Rejected then
					cancel()
					return reject(select(2, value:await()))
				end

				-- Chain a new Promise from this one so we only cancel ours
				local ourPromise = value:andThen(function(...)
					return ...
				end)

				table.insert(promisesToCancel, ourPromise)
				preprocessedList[index] = ourPromise
			else
				preprocessedList[index] = value
			end
		end

		for index, value in ipairs(preprocessedList) do
			if Promise.is(value) then
				local success
				success, value = value:await()

				if not success then
					cancel()
					return reject(value)
				end
			end

			if cancelled then
				return
			end

			local predicatePromise = Promise.resolve(predicate(value, index))

			table.insert(promisesToCancel, predicatePromise)

			local success, result = predicatePromise:await()

			if not success then
				cancel()
				return reject(result)
			end

			results[index] = result
		end

		resolve(results)
	end)
end

--[=[
	Checks whether the given object is a Promise via duck typing. This only checks if the object is a table and has an \`andThen\` method.

	@param object any
	@return boolean -- \`true\` if the given \`object\` is a Promise.
]=]
function Promise.is(object)
	if type(object) ~= "table" then
		return false
	end

	local objectMetatable = getmetatable(object)

	if objectMetatable == Promise then
		-- The Promise came from this library.
		return true
	elseif objectMetatable == nil then
		-- No metatable, but we should still chain onto tables with andThen methods
		return isCallable(object.andThen)
	elseif
		type(objectMetatable) == "table"
		and type(rawget(objectMetatable, "__index")) == "table"
		and isCallable(rawget(rawget(objectMetatable, "__index"), "andThen"))
	then
		-- Maybe this came from a different or older Promise library.
		return true
	end

	return false
end

--[=[
	Wraps a function that yields into one that returns a Promise.

	Any errors that occur while executing the function will be turned into rejections.

	:::info
	\`Promise.promisify\` is similar to [Promise.try](#try), except the callback is returned as a callable function instead of being invoked immediately.
	:::

	\`\`\`lua
	local sleep = Promise.promisify(wait)

	sleep(1):andThen(print)
	\`\`\`

	\`\`\`lua
	local isPlayerInGroup = Promise.promisify(function(player, groupId)
		return player:IsInGroup(groupId)
	end)
	\`\`\`

	@param callback (...: any) -> ...any
	@return (...: any) -> Promise
]=]
function Promise.promisify(callback)
	return function(...)
		return Promise._try(debug.traceback(nil, 2), callback, ...)
	end
end

--[=[
	Returns a Promise that resolves after \`seconds\` seconds have passed. The Promise resolves with the actual amount of time that was waited.

	This function is a wrapper around \`task.delay\`.

	:::warning
	Passing NaN, +Infinity, -Infinity, 0, or any other number less than the duration of a Heartbeat will cause the promise to resolve on the very next Heartbeat.
	:::

	\`\`\`lua
		Promise.delay(5):andThenCall(print, "This prints after 5 seconds")
	\`\`\`

	@function delay
	@within Promise
	@param seconds number
	@return Promise<number>
]=]
function Promise.delay(seconds)
	assert(type(seconds) == "number", "Bad argument #1 to Promise.delay, must be a number.")
	local startTime = Promise._getTime()
	return Promise._new(debug.traceback(nil, 2), function(resolve)
		task.delay(seconds, function()
			resolve(Promise._getTime() - startTime)
		end)
	end)
end

--[=[
	Returns a new Promise that resolves if the chained Promise resolves within \`seconds\` seconds, or rejects if execution time exceeds \`seconds\`. The chained Promise will be cancelled if the timeout is reached.

	Rejects with \`rejectionValue\` if it is non-nil. If a \`rejectionValue\` is not given, it will reject with a \`Promise.Error(Promise.Error.Kind.TimedOut)\`. This can be checked with [[Error.isKind]].

	\`\`\`lua
	getSomething():timeout(5):andThen(function(something)
		-- got something and it only took at max 5 seconds
	end):catch(function(e)
		-- Either getting something failed or the time was exceeded.

		if Promise.Error.isKind(e, Promise.Error.Kind.TimedOut) then
			warn("Operation timed out!")
		else
			warn("Operation encountered an error!")
		end
	end)
	\`\`\`

	Sugar for:

	\`\`\`lua
	Promise.race({
		Promise.delay(seconds):andThen(function()
			return Promise.reject(
				rejectionValue == nil
				and Promise.Error.new({ kind = Promise.Error.Kind.TimedOut })
				or rejectionValue
			)
		end),
		promise
	})
	\`\`\`

	@param seconds number
	@param rejectionValue? any -- The value to reject with if the timeout is reached
	@return Promise
]=]
function Promise.prototype:timeout(seconds, rejectionValue)
	local traceback = debug.traceback(nil, 2)

	return Promise.race({
		Promise.delay(seconds):andThen(function()
			return Promise.reject(rejectionValue == nil and Error.new({
				kind = Error.Kind.TimedOut,
				error = "Timed out",
				context = string.format(
					"Timeout of %d seconds exceeded.\n:timeout() called at:\n\n%s",
					seconds,
					traceback
				),
			}) or rejectionValue)
		end),
		self,
	})
end

--[=[
	Returns the current Promise status.

	@return Status
]=]
function Promise.prototype:getStatus()
	return self._status
end

--[[
	Creates a new promise that receives the result of this promise.

	The given callbacks are invoked depending on that result.
]]
function Promise.prototype:_andThen(traceback, successHandler, failureHandler)
	self._unhandledRejection = false

	-- If we are already cancelled, we return a cancelled Promise
	if self._status == Promise.Status.Cancelled then
		local promise = Promise.new(function() end)
		promise:cancel()

		return promise
	end

	-- Create a new promise to follow this part of the chain
	return Promise._new(traceback, function(resolve, reject, onCancel)
		-- Our default callbacks just pass values onto the next promise.
		-- This lets success and failure cascade correctly!

		local successCallback = resolve
		if successHandler then
			successCallback = createAdvancer(traceback, successHandler, resolve, reject)
		end

		local failureCallback = reject
		if failureHandler then
			failureCallback = createAdvancer(traceback, failureHandler, resolve, reject)
		end

		if self._status == Promise.Status.Started then
			-- If we haven't resolved yet, put ourselves into the queue
			table.insert(self._queuedResolve, successCallback)
			table.insert(self._queuedReject, failureCallback)

			onCancel(function()
				-- These are guaranteed to exist because the cancellation handler is guaranteed to only
				-- be called at most once
				if self._status == Promise.Status.Started then
					table.remove(self._queuedResolve, table.find(self._queuedResolve, successCallback))
					table.remove(self._queuedReject, table.find(self._queuedReject, failureCallback))
				end
			end)
		elseif self._status == Promise.Status.Resolved then
			-- This promise has already resolved! Trigger success immediately.
			successCallback(unpack(self._values, 1, self._valuesLength))
		elseif self._status == Promise.Status.Rejected then
			-- This promise died a terrible death! Trigger failure immediately.
			failureCallback(unpack(self._values, 1, self._valuesLength))
		end
	end, self)
end

--[=[
	Chains onto an existing Promise and returns a new Promise.

	:::warning
	Within the failure handler, you should never assume that the rejection value is a string. Some rejections within the Promise library are represented by [[Error]] objects. If you want to treat it as a string for debugging, you should call \`tostring\` on it first.
	:::

	You can return a Promise from the success or failure handler and it will be chained onto.

	Calling \`andThen\` on a cancelled Promise returns a cancelled Promise.

	:::tip
	If the Promise returned by \`andThen\` is cancelled, \`successHandler\` and \`failureHandler\` will not run.

	To run code no matter what, use [Promise:finally].
	:::

	@param successHandler (...: any) -> ...any
	@param failureHandler? (...: any) -> ...any
	@return Promise<...any>
]=]
function Promise.prototype:andThen(successHandler, failureHandler)
	assert(successHandler == nil or isCallable(successHandler), string.format(ERROR_NON_FUNCTION, "Promise:andThen"))
	assert(failureHandler == nil or isCallable(failureHandler), string.format(ERROR_NON_FUNCTION, "Promise:andThen"))

	return self:_andThen(debug.traceback(nil, 2), successHandler, failureHandler)
end

--[=[
	Shorthand for \`Promise:andThen(nil, failureHandler)\`.

	Returns a Promise that resolves if the \`failureHandler\` worked without encountering an additional error.

	:::warning
	Within the failure handler, you should never assume that the rejection value is a string. Some rejections within the Promise library are represented by [[Error]] objects. If you want to treat it as a string for debugging, you should call \`tostring\` on it first.
	:::

	Calling \`catch\` on a cancelled Promise returns a cancelled Promise.

	:::tip
	If the Promise returned by \`catch\` is cancelled,  \`failureHandler\` will not run.

	To run code no matter what, use [Promise:finally].
	:::

	@param failureHandler (...: any) -> ...any
	@return Promise<...any>
]=]
function Promise.prototype:catch(failureHandler)
	assert(failureHandler == nil or isCallable(failureHandler), string.format(ERROR_NON_FUNCTION, "Promise:catch"))
	return self:_andThen(debug.traceback(nil, 2), nil, failureHandler)
end

--[=[
	Similar to [Promise.andThen](#andThen), except the return value is the same as the value passed to the handler. In other words, you can insert a \`:tap\` into a Promise chain without affecting the value that downstream Promises receive.

	\`\`\`lua
		getTheValue()
		:tap(print)
		:andThen(function(theValue)
			print("Got", theValue, "even though print returns nil!")
		end)
	\`\`\`

	If you return a Promise from the tap handler callback, its value will be discarded but \`tap\` will still wait until it resolves before passing the original value through.

	@param tapHandler (...: any) -> ...any
	@return Promise<...any>
]=]
function Promise.prototype:tap(tapHandler)
	assert(isCallable(tapHandler), string.format(ERROR_NON_FUNCTION, "Promise:tap"))
	return self:_andThen(debug.traceback(nil, 2), function(...)
		local callbackReturn = tapHandler(...)

		if Promise.is(callbackReturn) then
			local length, values = pack(...)
			return callbackReturn:andThen(function()
				return unpack(values, 1, length)
			end)
		end

		return ...
	end)
end

--[=[
	Attaches an \`andThen\` handler to this Promise that calls the given callback with the predefined arguments. The resolved value is discarded.

	\`\`\`lua
		promise:andThenCall(someFunction, "some", "arguments")
	\`\`\`

	This is sugar for

	\`\`\`lua
		promise:andThen(function()
		return someFunction("some", "arguments")
		end)
	\`\`\`

	@param callback (...: any) -> any
	@param ...? any -- Additional arguments which will be passed to \`callback\`
	@return Promise
]=]
function Promise.prototype:andThenCall(callback, ...)
	assert(isCallable(callback), string.format(ERROR_NON_FUNCTION, "Promise:andThenCall"))
	local length, values = pack(...)
	return self:_andThen(debug.traceback(nil, 2), function()
		return callback(unpack(values, 1, length))
	end)
end

--[=[
	Attaches an \`andThen\` handler to this Promise that discards the resolved value and returns the given value from it.

	\`\`\`lua
		promise:andThenReturn("some", "values")
	\`\`\`

	This is sugar for

	\`\`\`lua
		promise:andThen(function()
			return "some", "values"
		end)
	\`\`\`

	:::caution
	Promises are eager, so if you pass a Promise to \`andThenReturn\`, it will begin executing before \`andThenReturn\` is reached in the chain. Likewise, if you pass a Promise created from [[Promise.reject]] into \`andThenReturn\`, it's possible that this will trigger the unhandled rejection warning. If you need to return a Promise, it's usually best practice to use [[Promise.andThen]].
	:::

	@param ... any -- Values to return from the function
	@return Promise
]=]
function Promise.prototype:andThenReturn(...)
	local length, values = pack(...)
	return self:_andThen(debug.traceback(nil, 2), function()
		return unpack(values, 1, length)
	end)
end

--[=[
	Cancels this promise, preventing the promise from resolving or rejecting. Does not do anything if the promise is already settled.

	Cancellations will propagate upwards and downwards through chained promises.

	Promises will only be cancelled if all of their consumers are also cancelled. This is to say that if you call \`andThen\` twice on the same promise, and you cancel only one of the child promises, it will not cancel the parent promise until the other child promise is also cancelled.

	\`\`\`lua
		promise:cancel()
	\`\`\`
]=]
function Promise.prototype:cancel()
	if self._status ~= Promise.Status.Started then
		return
	end

	self._status = Promise.Status.Cancelled

	if self._cancellationHook then
		self._cancellationHook()
	end

	coroutine.close(self._thread)

	if self._parent then
		self._parent:_consumerCancelled(self)
	end

	for child in pairs(self._consumers) do
		child:cancel()
	end

	self:_finalize()
end

--[[
	Used to decrease the number of consumers by 1, and if there are no more,
	cancel this promise.
]]
function Promise.prototype:_consumerCancelled(consumer)
	if self._status ~= Promise.Status.Started then
		return
	end

	self._consumers[consumer] = nil

	if next(self._consumers) == nil then
		self:cancel()
	end
end

--[[
	Used to set a handler for when the promise resolves, rejects, or is
	cancelled.
]]
function Promise.prototype:_finally(traceback, finallyHandler)
	self._unhandledRejection = false

	local promise = Promise._new(traceback, function(resolve, reject, onCancel)
		local handlerPromise

		onCancel(function()
			-- The finally Promise is not a proper consumer of self. We don't care about the resolved value.
			-- All we care about is running at the end. Therefore, if self has no other consumers, it's safe to
			-- cancel. We don't need to hold out cancelling just because there's a finally handler.
			self:_consumerCancelled(self)

			if handlerPromise then
				handlerPromise:cancel()
			end
		end)

		local finallyCallback = resolve
		if finallyHandler then
			finallyCallback = function(...)
				local ok, _, resultList = runExecutor(traceback, finallyHandler, ...)
				local result = resultList[1]
				if not ok then
					return reject(result)
				end

				if Promise.is(result) then
					handlerPromise = result

					result
						:finally(function(status)
							if status ~= Promise.Status.Rejected then
								resolve(self)
							end
						end)
						:catch(function(...)
							reject(...)
						end)
				else
					resolve(self)
				end
			end
		end

		if self._status == Promise.Status.Started then
			-- The promise is not settled, so queue this.
			table.insert(self._queuedFinally, finallyCallback)
		else
			-- The promise already settled or was cancelled, run the callback now.
			finallyCallback(self._status)
		end
	end)

	return promise
end

--[=[
	Set a handler that will be called regardless of the promise's fate. The handler is called when the promise is
	resolved, rejected, *or* cancelled.

	Returns a new Promise that:
	- resolves with the same values that this Promise resolves with.
	- rejects with the same values that this Promise rejects with.
	- is cancelled if this Promise is cancelled.

	If the value you return from the handler is a Promise:
	- We wait for the Promise to resolve, but we ultimately discard the resolved value.
	- If the returned Promise rejects, the Promise returned from \`finally\` will reject with the rejected value from the
	*returned* promise.
	- If the \`finally\` Promise is cancelled, and you returned a Promise from the handler, we cancel that Promise too.

	Otherwise, the return value from the \`finally\` handler is entirely discarded.

	:::note Cancellation
	As of Promise v4, \`Promise:finally\` does not count as a consumer of the parent Promise for cancellation purposes.
	This means that if all of a Promise's consumers are cancelled and the only remaining callbacks are finally handlers,
	the Promise is cancelled and the finally callbacks run then and there.

	Cancellation still propagates through the \`finally\` Promise though: if you cancel the \`finally\` Promise, it can cancel
	its parent Promise if it had no other consumers. Likewise, if the parent Promise is cancelled, the \`finally\` Promise
	will also be cancelled.
	:::

	\`\`\`lua
	local thing = createSomething()

	doSomethingWith(thing)
		:andThen(function()
			print("It worked!")
			-- do something..
		end)
		:catch(function()
			warn("Oh no it failed!")
		end)
		:finally(function()
			-- either way, destroy thing

			thing:Destroy()
		end)

	\`\`\`

	@param finallyHandler (status: Status) -> ...any
	@return Promise<...any>
]=]
function Promise.prototype:finally(finallyHandler)
	assert(finallyHandler == nil or isCallable(finallyHandler), string.format(ERROR_NON_FUNCTION, "Promise:finally"))
	return self:_finally(debug.traceback(nil, 2), finallyHandler)
end

--[=[
	Same as \`andThenCall\`, except for \`finally\`.

	Attaches a \`finally\` handler to this Promise that calls the given callback with the predefined arguments.

	@param callback (...: any) -> any
	@param ...? any -- Additional arguments which will be passed to \`callback\`
	@return Promise
]=]
function Promise.prototype:finallyCall(callback, ...)
	assert(isCallable(callback), string.format(ERROR_NON_FUNCTION, "Promise:finallyCall"))
	local length, values = pack(...)
	return self:_finally(debug.traceback(nil, 2), function()
		return callback(unpack(values, 1, length))
	end)
end

--[=[
	Attaches a \`finally\` handler to this Promise that discards the resolved value and returns the given value from it.

	\`\`\`lua
		promise:finallyReturn("some", "values")
	\`\`\`

	This is sugar for

	\`\`\`lua
		promise:finally(function()
			return "some", "values"
		end)
	\`\`\`

	@param ... any -- Values to return from the function
	@return Promise
]=]
function Promise.prototype:finallyReturn(...)
	local length, values = pack(...)
	return self:_finally(debug.traceback(nil, 2), function()
		return unpack(values, 1, length)
	end)
end

--[=[
	Yields the current thread until the given Promise completes. Returns the Promise's status, followed by the values that the promise resolved or rejected with.

	@yields
	@return Status -- The Status representing the fate of the Promise
	@return ...any -- The values the Promise resolved or rejected with.
]=]
function Promise.prototype:awaitStatus()
	self._unhandledRejection = false

	if self._status == Promise.Status.Started then
		local thread = coroutine.running()

		self
			:finally(function()
				task.spawn(thread)
			end)
			-- The finally promise can propagate rejections, so we attach a catch handler to prevent the unhandled
			-- rejection warning from appearing
			:catch(
				function() end
			)

		coroutine.yield()
	end

	if self._status == Promise.Status.Resolved then
		return self._status, unpack(self._values, 1, self._valuesLength)
	elseif self._status == Promise.Status.Rejected then
		return self._status, unpack(self._values, 1, self._valuesLength)
	end

	return self._status
end

local function awaitHelper(status, ...)
	return status == Promise.Status.Resolved, ...
end

--[=[
	Yields the current thread until the given Promise completes. Returns true if the Promise resolved, followed by the values that the promise resolved or rejected with.

	:::caution
	If the Promise gets cancelled, this function will return \`false\`, which is indistinguishable from a rejection. If you need to differentiate, you should use [[Promise.awaitStatus]] instead.
	:::

	\`\`\`lua
		local worked, value = getTheValue():await()

	if worked then
		print("got", value)
	else
		warn("it failed")
	end
	\`\`\`

	@yields
	@return boolean -- \`true\` if the Promise successfully resolved
	@return ...any -- The values the Promise resolved or rejected with.
]=]
function Promise.prototype:await()
	return awaitHelper(self:awaitStatus())
end

local function expectHelper(status, ...)
	if status ~= Promise.Status.Resolved then
		error((...) == nil and "Expected Promise rejected with no value." or (...), 3)
	end

	return ...
end

--[=[
	Yields the current thread until the given Promise completes. Returns the values that the promise resolved with.

	\`\`\`lua
	local worked = pcall(function()
		print("got", getTheValue():expect())
	end)

	if not worked then
		warn("it failed")
	end
	\`\`\`

	This is essentially sugar for:

	\`\`\`lua
	select(2, assert(promise:await()))
	\`\`\`

	**Errors** if the Promise rejects or gets cancelled.

	@error any -- Errors with the rejection value if this Promise rejects or gets cancelled.
	@yields
	@return ...any -- The values the Promise resolved with.
]=]
function Promise.prototype:expect()
	return expectHelper(self:awaitStatus())
end

-- Backwards compatibility
Promise.prototype.awaitValue = Promise.prototype.expect

--[[
	Intended for use in tests.

	Similar to await(), but instead of yielding if the promise is unresolved,
	_unwrap will throw. This indicates an assumption that a promise has
	resolved.
]]
function Promise.prototype:_unwrap()
	if self._status == Promise.Status.Started then
		error("Promise has not resolved or rejected.", 2)
	end

	local success = self._status == Promise.Status.Resolved

	return success, unpack(self._values, 1, self._valuesLength)
end

function Promise.prototype:_resolve(...)
	if self._status ~= Promise.Status.Started then
		if Promise.is((...)) then
			(...):_consumerCancelled(self)
		end
		return
	end

	-- If the resolved value was a Promise, we chain onto it!
	if Promise.is((...)) then
		-- Without this warning, arguments sometimes mysteriously disappear
		if select("#", ...) > 1 then
			local message = string.format(
				"When returning a Promise from andThen, extra arguments are " .. "discarded! See:\n\n%s",
				self._source
			)
			warn(message)
		end

		local chainedPromise = ...

		local promise = chainedPromise:andThen(function(...)
			self:_resolve(...)
		end, function(...)
			local maybeRuntimeError = chainedPromise._values[1]

			-- Backwards compatibility < v2
			if chainedPromise._error then
				maybeRuntimeError = Error.new({
					error = chainedPromise._error,
					kind = Error.Kind.ExecutionError,
					context = "[No stack trace available as this Promise originated from an older version of the Promise library (< v2)]",
				})
			end

			if Error.isKind(maybeRuntimeError, Error.Kind.ExecutionError) then
				return self:_reject(maybeRuntimeError:extend({
					error = "This Promise was chained to a Promise that errored.",
					trace = "",
					context = string.format(
						"The Promise at:\n\n%s\n...Rejected because it was chained to the following Promise, which encountered an error:\n",
						self._source
					),
				}))
			end

			self:_reject(...)
		end)

		if promise._status == Promise.Status.Cancelled then
			self:cancel()
		elseif promise._status == Promise.Status.Started then
			-- Adopt ourselves into promise for cancellation propagation.
			self._parent = promise
			promise._consumers[self] = true
		end

		return
	end

	self._status = Promise.Status.Resolved
	self._valuesLength, self._values = pack(...)

	-- We assume that these callbacks will not throw errors.
	for _, callback in ipairs(self._queuedResolve) do
		coroutine.wrap(callback)(...)
	end

	self:_finalize()
end

function Promise.prototype:_reject(...)
	if self._status ~= Promise.Status.Started then
		return
	end

	self._status = Promise.Status.Rejected
	self._valuesLength, self._values = pack(...)

	-- If there are any rejection handlers, call those!
	if not isEmpty(self._queuedReject) then
		-- We assume that these callbacks will not throw errors.
		for _, callback in ipairs(self._queuedReject) do
			coroutine.wrap(callback)(...)
		end
	else
		-- At this point, no one was able to observe the error.
		-- An error handler might still be attached if the error occurred
		-- synchronously. We'll wait one tick, and if there are still no
		-- observers, then we should put a message in the console.

		local err = tostring((...))

		coroutine.wrap(function()
			Promise._timeEvent:Wait()

			-- Someone observed the error, hooray!
			if not self._unhandledRejection then
				return
			end

			-- Build a reasonable message
			local message = string.format("Unhandled Promise rejection:\n\n%s\n\n%s", err, self._source)

			for _, callback in ipairs(Promise._unhandledRejectionCallbacks) do
				task.spawn(callback, self, unpack(self._values, 1, self._valuesLength))
			end

			if Promise.TEST then
				-- Don't spam output when we're running tests.
				return
			end

			warn(message)
		end)()
	end

	self:_finalize()
end

--[[
	Calls any :finally handlers. We need this to be a separate method and
	queue because we must call all of the finally callbacks upon a success,
	failure, *and* cancellation.
]]
function Promise.prototype:_finalize()
	for _, callback in ipairs(self._queuedFinally) do
		-- Purposefully not passing values to callbacks here, as it could be the
		-- resolved values, or rejected errors. If the developer needs the values,
		-- they should use :andThen or :catch explicitly.
		coroutine.wrap(callback)(self._status)
	end

	self._queuedFinally = nil
	self._queuedReject = nil
	self._queuedResolve = nil

	-- Clear references to other Promises to allow gc
	if not Promise.TEST then
		self._parent = nil
		self._consumers = nil
	end

	task.defer(coroutine.close, self._thread)
end

--[=[
	Chains a Promise from this one that is resolved if this Promise is already resolved, and rejected if it is not resolved at the time of calling \`:now()\`. This can be used to ensure your \`andThen\` handler occurs on the same frame as the root Promise execution.

	\`\`\`lua
	doSomething()
		:now()
		:andThen(function(value)
			print("Got", value, "synchronously.")
		end)
	\`\`\`

	If this Promise is still running, Rejected, or Cancelled, the Promise returned from \`:now()\` will reject with the \`rejectionValue\` if passed, otherwise with a \`Promise.Error(Promise.Error.Kind.NotResolvedInTime)\`. This can be checked with [[Error.isKind]].

	@param rejectionValue? any -- The value to reject with if the Promise isn't resolved
	@return Promise
]=]
function Promise.prototype:now(rejectionValue)
	local traceback = debug.traceback(nil, 2)
	if self._status == Promise.Status.Resolved then
		return self:_andThen(traceback, function(...)
			return ...
		end)
	else
		return Promise.reject(rejectionValue == nil and Error.new({
			kind = Error.Kind.NotResolvedInTime,
			error = "This Promise was not resolved in time for :now()",
			context = ":now() was called at:\n\n" .. traceback,
		}) or rejectionValue)
	end
end

--[=[
	Repeatedly calls a Promise-returning function up to \`times\` number of times, until the returned Promise resolves.

	If the amount of retries is exceeded, the function will return the latest rejected Promise.

	\`\`\`lua
	local function canFail(a, b, c)
		return Promise.new(function(resolve, reject)
			-- do something that can fail

			local failed, thing = doSomethingThatCanFail(a, b, c)

			if failed then
				reject("it failed")
			else
				resolve(thing)
			end
		end)
	end

	local MAX_RETRIES = 10
	local value = Promise.retry(canFail, MAX_RETRIES, "foo", "bar", "baz") -- args to send to canFail
	\`\`\`

	@since 3.0.0
	@param callback (...: P) -> Promise<T>
	@param times number
	@param ...? P
	@return Promise<T>
]=]
function Promise.retry(callback, times, ...)
	assert(isCallable(callback), "Parameter #1 to Promise.retry must be a function")
	assert(type(times) == "number", "Parameter #2 to Promise.retry must be a number")

	local args, length = { ... }, select("#", ...)

	return Promise.resolve(callback(...)):catch(function(...)
		if times > 0 then
			return Promise.retry(callback, times - 1, unpack(args, 1, length))
		else
			return Promise.reject(...)
		end
	end)
end

--[=[
	Repeatedly calls a Promise-returning function up to \`times\` number of times, waiting \`seconds\` seconds between each
	retry, until the returned Promise resolves.

	If the amount of retries is exceeded, the function will return the latest rejected Promise.

	@since v3.2.0
	@param callback (...: P) -> Promise<T>
	@param times number
	@param seconds number
	@param ...? P
	@return Promise<T>
]=]
function Promise.retryWithDelay(callback, times, seconds, ...)
	assert(isCallable(callback), "Parameter #1 to Promise.retry must be a function")
	assert(type(times) == "number", "Parameter #2 (times) to Promise.retry must be a number")
	assert(type(seconds) == "number", "Parameter #3 (seconds) to Promise.retry must be a number")

	local args, length = { ... }, select("#", ...)
	
	-- suziimisi <3
	
	return Promise.resolve(callback(...)):catch(function(...)
		if times > 0 then
			Promise.delay(seconds):await()

			return Promise.retryWithDelay(callback, times - 1, seconds, unpack(args, 1, length))
		else
			return Promise.reject(...)
		end
	end)
end

--[=[
	Converts an event into a Promise which resolves the next time the event fires.

	The optional \`predicate\` callback, if passed, will receive the event arguments and should return \`true\` or \`false\`, based on if this fired event should resolve the Promise or not. If \`true\`, the Promise resolves. If \`false\`, nothing happens and the predicate will be rerun the next time the event fires.

	The Promise will resolve with the event arguments.

	:::tip
	This function will work given any object with a \`Connect\` method. This includes all Roblox events.
	:::

	\`\`\`lua
	-- Creates a Promise which only resolves when \`somePart\` is touched
	-- by a part named \`"Something specific"\`.
	return Promise.fromEvent(somePart.Touched, function(part)
		return part.Name == "Something specific"
	end)
	\`\`\`

	@since 3.0.0
	@param event Event -- Any object with a \`Connect\` method. This includes all Roblox events.
	@param predicate? (...: P) -> boolean -- A function which determines if the Promise should resolve with the given value, or wait for the next event to check again.
	@return Promise<P>
]=]
function Promise.fromEvent(event, predicate)
	predicate = predicate or function()
		return true
	end

	return Promise._new(debug.traceback(nil, 2), function(resolve, _, onCancel)
		local connection
		local shouldDisconnect = false

		local function disconnect()
			connection:Disconnect()
			connection = nil
		end

		-- We use shouldDisconnect because if the callback given to Connect is called before
		-- Connect returns, connection will still be nil. This happens with events that queue up
		-- events when there's nothing connected, such as RemoteEvents

		connection = event:Connect(function(...)
			local callbackValue = predicate(...)

			if callbackValue == true then
				resolve(...)

				if connection then
					disconnect()
				else
					shouldDisconnect = true
				end
			elseif type(callbackValue) ~= "boolean" then
				error("Promise.fromEvent predicate should always return a boolean")
			end
		end)

		if shouldDisconnect and connection then
			return disconnect()
		end

		onCancel(disconnect)
	end)
end

--[=[
	Registers a callback that runs when an unhandled rejection happens. An unhandled rejection happens when a Promise
	is rejected, and the rejection is not observed with \`:catch\`.

	The callback is called with the actual promise that rejected, followed by the rejection values.

	@since v3.2.0
	@param callback (promise: Promise, ...: any) -- A callback that runs when an unhandled rejection happens.
	@return () -> () -- Function that unregisters the \`callback\` when called
]=]
function Promise.onUnhandledRejection(callback)
	table.insert(Promise._unhandledRejectionCallbacks, callback)

	return function()
		local index = table.find(Promise._unhandledRejectionCallbacks, callback)

		if index then
			table.remove(Promise._unhandledRejectionCallbacks, index)
		end
	end
end

return Promise`,

        'Server.luau': `--!strict
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local ServerScriptService = game:GetService("ServerScriptService")
local Spark = require(ReplicatedStorage:WaitForChild("Spark"):WaitForChild("Spark"))

Spark.AddModules(ServerScriptService:WaitForChild("Services"))

Spark.Start():andThen(function()
    print("[Spark] Server started")
end):catch(function(err: any)
    warn("[Spark] Server startup error: " .. tostring(err))
end)`,

        'Service.luau': `--!strict
local Players = game:GetService("Players")
local Signal = require(script.Parent:WaitForChild("Signal"))
local Network = require(script.Parent:WaitForChild("Network"))

export type RemoteSignal = {
    Fire: (self: RemoteSignal, player: Player, ...any) -> (),
    FireAll: (self: RemoteSignal, ...any) -> (),
    FireExcept: (self: RemoteSignal, except: Player, ...any) -> (),
    Connect: (self: RemoteSignal, fn: (player: Player, ...any) -> ()) -> Signal.Connection,
    Destroy: (self: RemoteSignal) -> (),
}

type RemoteSignalInternal = {
    _remote: RemoteEvent,
    _signal: Signal.Signal,
    _conn: RBXScriptConnection?,
    Fire: (self: RemoteSignalInternal, player: Player, ...any) -> (),
    FireAll: (self: RemoteSignalInternal, ...any) -> (),
    FireExcept: (self: RemoteSignalInternal, except: Player, ...any) -> (),
    Connect: (self: RemoteSignalInternal, fn: (player: Player, ...any) -> ()) -> Signal.Connection,
    Destroy: (self: RemoteSignalInternal) -> (),
}

type UnreliableRemoteSignalInternal = {
    _remote: UnreliableRemoteEvent,
    _signal: Signal.Signal,
    _conn: RBXScriptConnection?,
    Fire: (self: UnreliableRemoteSignalInternal, player: Player, ...any) -> (),
    FireAll: (self: UnreliableRemoteSignalInternal, ...any) -> (),
    FireExcept: (self: UnreliableRemoteSignalInternal, except: Player, ...any) -> (),
    Connect: (self: UnreliableRemoteSignalInternal, fn: (player: Player, ...any) -> ()) -> Signal.Connection,
    Destroy: (self: UnreliableRemoteSignalInternal) -> (),
}

export type RemoteProperty = {
    Set: (self: RemoteProperty, value: any) -> (),
    SetFor: (self: RemoteProperty, player: Player, value: any) -> (),
    SetFilter: (self: RemoteProperty, predicate: (player: Player) -> boolean, value: any) -> (),
    Get: (self: RemoteProperty) -> any,
    GetFor: (self: RemoteProperty, player: Player) -> any,
    Destroy: (self: RemoteProperty) -> (),
}

type RemotePropertyInternal = {
    _value: any,
    _playerValues: { [Player]: any },
    _updateEvent: RemoteEvent,
    _playerConn: RBXScriptConnection?,
    Set: (self: RemotePropertyInternal, value: any) -> (),
    SetFor: (self: RemotePropertyInternal, player: Player, value: any) -> (),
    SetFilter: (self: RemotePropertyInternal, predicate: (player: Player) -> boolean, value: any) -> (),
    Get: (self: RemotePropertyInternal) -> any,
    GetFor: (self: RemotePropertyInternal, player: Player) -> any,
    Destroy: (self: RemotePropertyInternal) -> (),
}

export type ServiceConfig = {
    Name: string,
    Client: { [string]: any }?,
    [string]: any,
}

export type Service = {
    Name: string,
    Client: { [string]: any },
    [string]: any,
}

local RemoteSignalClass = {}
RemoteSignalClass.__index = RemoteSignalClass

local function rsFire(self: RemoteSignalInternal, player: Player, ...: any): ()
    self._remote:FireClient(player, ...)
end
RemoteSignalClass.Fire = rsFire

local function rsFireAll(self: RemoteSignalInternal, ...: any): ()
    self._remote:FireAllClients(...)
end
RemoteSignalClass.FireAll = rsFireAll

local function rsFireExcept(self: RemoteSignalInternal, except: Player, ...: any): ()
    for _, player in Players:GetPlayers() do
        if player ~= except then
            self._remote:FireClient(player, ...)
        end
    end
end
RemoteSignalClass.FireExcept = rsFireExcept

local function rsConnect(self: RemoteSignalInternal, fn: (player: Player, ...any) -> ()): Signal.Connection
    return self._signal:Connect(fn)
end
RemoteSignalClass.Connect = rsConnect

local function rsDestroy(self: RemoteSignalInternal): ()
    if self._conn ~= nil then
        self._conn:Disconnect()
        self._conn = nil
    end
    self._signal:Destroy()
end
RemoteSignalClass.Destroy = rsDestroy

local function createRemoteSignal(serviceName: string, memberName: string): RemoteSignalInternal
    local remote: RemoteEvent = Network.GetRemoteEvent(serviceName, memberName)
    local signal: Signal.Signal = Signal.new()
    local self: RemoteSignalInternal = setmetatable({
        _remote = remote,
        _signal = signal,
        _conn = nil,
    }, RemoteSignalClass) :: any

    self._conn = remote.OnServerEvent:Connect(function(player: Player, ...: any)
        signal:Fire(player, ...)
    end)

    return self
end

local UnreliableRemoteSignalClass = {}
UnreliableRemoteSignalClass.__index = UnreliableRemoteSignalClass

local function ursFire(self: UnreliableRemoteSignalInternal, player: Player, ...: any): ()
    self._remote:FireClient(player, ...)
end
UnreliableRemoteSignalClass.Fire = ursFire

local function ursFireAll(self: UnreliableRemoteSignalInternal, ...: any): ()
    self._remote:FireAllClients(...)
end
UnreliableRemoteSignalClass.FireAll = ursFireAll

local function ursFireExcept(self: UnreliableRemoteSignalInternal, except: Player, ...: any): ()
    for _, player in Players:GetPlayers() do
        if player ~= except then
            self._remote:FireClient(player, ...)
        end
    end
end
UnreliableRemoteSignalClass.FireExcept = ursFireExcept

local function ursConnect(self: UnreliableRemoteSignalInternal, fn: (player: Player, ...any) -> ()): Signal.Connection
    return self._signal:Connect(fn)
end
UnreliableRemoteSignalClass.Connect = ursConnect

local function ursDestroy(self: UnreliableRemoteSignalInternal): ()
    if self._conn ~= nil then
        self._conn:Disconnect()
        self._conn = nil
    end
    self._signal:Destroy()
end
UnreliableRemoteSignalClass.Destroy = ursDestroy

local function createUnreliableRemoteSignal(serviceName: string, memberName: string): UnreliableRemoteSignalInternal
    local remote: UnreliableRemoteEvent = Network.GetUnreliableRemoteEvent(serviceName, memberName)
    local signal: Signal.Signal = Signal.new()
    local self: UnreliableRemoteSignalInternal = setmetatable({
        _remote = remote,
        _signal = signal,
        _conn = nil,
    }, UnreliableRemoteSignalClass) :: any

    self._conn = remote.OnServerEvent:Connect(function(player: Player, ...: any)
        signal:Fire(player, ...)
    end)

    return self
end

local RemotePropertyClass = {}
RemotePropertyClass.__index = RemotePropertyClass

local function rpSet(self: RemotePropertyInternal, value: any): ()
    self._value = value
    for _, player in Players:GetPlayers() do
        if self._playerValues[player] == nil then
            self._updateEvent:FireClient(player, value)
        end
    end
end
RemotePropertyClass.Set = rpSet

local function rpSetFor(self: RemotePropertyInternal, player: Player, value: any): ()
    self._playerValues[player] = value
    self._updateEvent:FireClient(player, value)
end
RemotePropertyClass.SetFor = rpSetFor

local function rpSetFilter(self: RemotePropertyInternal, predicate: (player: Player) -> boolean, value: any): ()
    for _, player in Players:GetPlayers() do
        if predicate(player) then
            self._playerValues[player] = value
            self._updateEvent:FireClient(player, value)
        end
    end
end
RemotePropertyClass.SetFilter = rpSetFilter

local function rpGet(self: RemotePropertyInternal): any
    return self._value
end
RemotePropertyClass.Get = rpGet

local function rpGetFor(self: RemotePropertyInternal, player: Player): any
    local perPlayer = self._playerValues[player]
    if perPlayer ~= nil then
        return perPlayer
    end
    return self._value
end
RemotePropertyClass.GetFor = rpGetFor

local function rpDestroy(self: RemotePropertyInternal): ()
    local conn = self._playerConn
    if conn ~= nil then
        conn:Disconnect()
        self._playerConn = nil
    end
    table.clear(self._playerValues)
end
RemotePropertyClass.Destroy = rpDestroy

local function createRemoteProperty(serviceName: string, memberName: string, defaultValue: any): RemotePropertyInternal
    local updateEvent: RemoteEvent = Network.GetPropertyUpdateEvent(serviceName, memberName)
    local initFunc: RemoteFunction = Network.GetPropertyInitFunction(serviceName, memberName)
    local self: RemotePropertyInternal = setmetatable({
        _value = defaultValue,
        _playerValues = setmetatable({}, { __mode = "k" }) :: { [Player]: any },
        _updateEvent = updateEvent,
        _playerConn = nil,
    }, RemotePropertyClass) :: any

    initFunc.OnServerInvoke = function(player: Player): any
        return rpGetFor(self, player)
    end

    self._playerConn = Players.PlayerRemoving:Connect(function(player: Player)
        self._playerValues[player] = nil
    end)

    return self
end

local ServiceModule = {}
local createdServices: { [string]: Service } = {}
local startupLocked: boolean = false

function ServiceModule._lock(): ()
    startupLocked = true
end

function ServiceModule._getAll(): { [string]: Service }
    return createdServices
end

function ServiceModule.CreateService(config: ServiceConfig): Service
    assert(not startupLocked, "[Spark.Service] Cannot create a Service after Spark.Start()")
    assert(type(config) == "table", "[Spark.Service] CreateService expects a table")
    assert(type(config.Name) == "string" and config.Name ~= "", "[Spark.Service] Service requires a non-empty Name")
    assert(createdServices[config.Name] == nil, "[Spark.Service] Duplicate Service name: " .. config.Name)

    if config.Client == nil then
        config.Client = {}
    end

    local service: Service = config :: any
    service.Client.Server = service
    createdServices[config.Name] = service

    return service
end

function ServiceModule._bindClient(service: Service): ()
    local clientTable = service.Client
    local replacements: { [string]: any } = {}

    for memberName, value in clientTable do
        if memberName == "Server" then
            continue
        end

        if type(value) == "function" then
            local remote: RemoteFunction = Network.GetRemoteFunction(service.Name, memberName)
            local boundFn = value
            remote.OnServerInvoke = function(player: Player, ...: any): ...any
                return boundFn(clientTable, player, ...)
            end
        elseif type(value) == "table" then
            local t = value :: { [string]: any }
            if t._sparkRemoteSignalMarker == true then
                replacements[memberName] = createRemoteSignal(service.Name, memberName)
            elseif t._sparkUnreliableSignalMarker == true then
                replacements[memberName] = createUnreliableRemoteSignal(service.Name, memberName)
            elseif t._sparkRemotePropertyMarker == true then
                replacements[memberName] = createRemoteProperty(service.Name, memberName, t._default)
            end
        end
    end

    for memberName, obj in replacements do
        clientTable[memberName] = obj
    end
end

function ServiceModule.CreateRemoteSignal(): any
    return { _sparkRemoteSignalMarker = true }
end

function ServiceModule.CreateUnreliableRemoteSignal(): any
    return { _sparkUnreliableSignalMarker = true }
end

function ServiceModule.CreateRemoteProperty(defaultValue: any): any
    return { _sparkRemotePropertyMarker = true, _default = defaultValue }
end

return ServiceModule`,

        'Signal.luau': `--!strict
export type Connection = {
    Connected: boolean,
    Disconnect: (self: Connection) -> (),
}

type ConnectionInternal = {
    Connected: boolean,
    _signal: SignalInternal?,
    _fn: ((...any) -> ())?,
    _next: ConnectionInternal?,
    Disconnect: (self: ConnectionInternal) -> (),
}

type SignalInternal = {
    _head: ConnectionInternal?,
    _alive: boolean,
    Connect: (self: SignalInternal, fn: (...any) -> ()) -> ConnectionInternal,
    Once: (self: SignalInternal, fn: (...any) -> ()) -> ConnectionInternal,
    Wait: (self: SignalInternal) -> ...any,
    Fire: (self: SignalInternal, ...any) -> (),
    DisconnectAll: (self: SignalInternal) -> (),
    Destroy: (self: SignalInternal) -> (),
}

export type Signal = {
    Connect: (self: Signal, fn: (...any) -> ()) -> Connection,
    Once: (self: Signal, fn: (...any) -> ()) -> Connection,
    Wait: (self: Signal) -> ...any,
    Fire: (self: Signal, ...any) -> (),
    DisconnectAll: (self: Signal) -> (),
    Destroy: (self: Signal) -> (),
}

local Connection = {}
Connection.__index = Connection

local function disconnect(self: ConnectionInternal): ()
    if not self.Connected then
        return
    end
    self.Connected = false

    local signal = self._signal
    if signal == nil then
        return
    end

    if signal._head == self then
        signal._head = self._next
    else
        local current = signal._head
        while current ~= nil do
            if current._next == self then
                current._next = self._next
                break
            end
            current = current._next
        end
    end

    self._signal = nil
    self._fn = nil
end
Connection.Disconnect = disconnect

local Signal = {}
Signal.__index = Signal

local function fire(self: SignalInternal, ...: any): ()
    local current = self._head
    while current ~= nil do
        local nextConn = current._next
        if current.Connected then
            local fn = current._fn
            if fn ~= nil then
                task.spawn(fn, ...)
            end
        end
        current = nextConn
    end
end
Signal.Fire = fire

local function connect(self: SignalInternal, fn: (...any) -> ()): ConnectionInternal
    assert(self._alive, "[Spark.Signal] Cannot connect to a destroyed Signal")
    assert(type(fn) == "function", "[Spark.Signal] Connect expects a function")

    local conn: ConnectionInternal = setmetatable({
        Connected = true,
        _signal = self,
        _fn = fn,
        _next = self._head,
    }, Connection) :: any

    self._head = conn
    return conn
end
Signal.Connect = connect

local function once(self: SignalInternal, fn: (...any) -> ()): ConnectionInternal
    local holder: { ref: ConnectionInternal? } = { ref = nil }
    local conn: ConnectionInternal = connect(self, function(...: any)
        local ref = holder.ref
        if ref ~= nil then
            disconnect(ref)
        end
        fn(...)
    end)
    holder.ref = conn
    return conn
end
Signal.Once = once

local function wait(self: SignalInternal): ...any
    local running: thread = coroutine.running()
    local holder: { ref: ConnectionInternal? } = { ref = nil }
    local conn: ConnectionInternal = connect(self, function(...: any)
        local ref = holder.ref
        if ref ~= nil then
            disconnect(ref)
        end
        if coroutine.status(running) == "suspended" then
            task.spawn(running, ...)
        end
    end)
    holder.ref = conn
    return coroutine.yield()
end
Signal.Wait = wait

local function disconnectAll(self: SignalInternal): ()
    local current = self._head
    while current ~= nil do
        local nextConn = current._next
        current.Connected = false
        current._signal = nil
        current._fn = nil
        current._next = nil
        current = nextConn
    end
    self._head = nil
end
Signal.DisconnectAll = disconnectAll

local function destroy(self: SignalInternal): ()
    disconnectAll(self)
    self._alive = false
end
Signal.Destroy = destroy

local SignalConstructor = {}
function SignalConstructor.new(): Signal
    local self: SignalInternal = setmetatable({
        _head = nil,
        _alive = true,
    }, Signal) :: any
    return self :: any
end

return SignalConstructor`,

        'Spark.luau': `--!strict
local RunService = game:GetService("RunService")
local Players = game:GetService("Players")

local Signal = require(script:WaitForChild("Signal"))
local Network = require(script:WaitForChild("Network"))
local Promise = require(script:WaitForChild("Promise"))
local ServiceModule = require(script:WaitForChild("Service"))
local ControllerModule = require(script:WaitForChild("Controller"))

local IS_SERVER: boolean = RunService:IsServer()
local IS_CLIENT: boolean = RunService:IsClient()

export type Service = ServiceModule.Service
export type Controller = ControllerModule.Controller
export type Signal = Signal.Signal
export type Connection = Signal.Connection
export type RemoteSignal = ServiceModule.RemoteSignal
export type RemoteProperty = ServiceModule.RemoteProperty

type SparkState = "Idle" | "Starting" | "Running"

type ClientRemotePropertyProxy = {
    Get: (self: ClientRemotePropertyProxy) -> any,
    Observe: (self: ClientRemotePropertyProxy, fn: (value: any) -> ()) -> Signal.Connection,
    Destroy: (self: ClientRemotePropertyProxy) -> (),
}

type ClientServiceProxy = {
    Name: string,
    [string]: any,
}

local Spark = {}
Spark.Util = {
    Signal = Signal,
    Promise = Promise,
    Network = Network,
}

local state: SparkState = "Idle"
local startPromise: any = nil
local clientServiceCache: { [string]: ClientServiceProxy } = {}

Spark.CreateService = ServiceModule.CreateService
Spark.CreateController = ControllerModule.CreateController
Spark.CreateRemoteSignal = ServiceModule.CreateRemoteSignal
Spark.CreateUnreliableRemoteSignal = ServiceModule.CreateUnreliableRemoteSignal
Spark.CreateRemoteProperty = ServiceModule.CreateRemoteProperty

local function safeRequire(module: ModuleScript): ()
    local ok: boolean, err: any = pcall(require, module)
    if not ok then
        warn("[Spark] Failed to require '" .. module:GetFullName() .. "': " .. tostring(err))
    end
end

function Spark.AddModules(parent: Instance): ()
    assert(state == "Idle", "[Spark] AddModules must be called before Spark.Start()")
    for _, descendant in parent:GetDescendants() do
        if descendant:IsA("ModuleScript") then
            safeRequire(descendant)
        end
    end
end

local function runLifecycleStage(objects: { [string]: any }, methodName: string): any
    return Promise.new(function(resolve: (...any) -> (), reject: (...any) -> ())
        local toRun: { any } = {}
        for _, object in objects do
            if type(object[methodName]) == "function" then
                table.insert(toRun, object)
            end
        end

        local total: number = #toRun
        if total == 0 then
            resolve()
            return
        end

        local completed: number = 0
        local settled: boolean = false

        for _, object in toRun do
            task.spawn(function()
                local ok: boolean, result: any = pcall(object[methodName] :: (any) -> any, object)
                if settled then
                    return
                end

                if not ok then
                    settled = true
                    reject("[Spark] " .. methodName .. " error in '" .. tostring(object.Name) .. "': " .. tostring(result))
                    return
                end

                if Promise.is(result) then
                    result:andThen(function()
                        if settled then
                            return
                        end
                        completed += 1
                        if completed == total then
                            settled = true
                            resolve()
                        end
                    end):catch(function(err: any)
                        if settled then
                            return
                        end
                        settled = true
                        reject("[Spark] " .. methodName .. " error in '" .. tostring(object.Name) .. "': " .. tostring(err))
                    end)
                else
                    completed += 1
                    if completed == total then
                        settled = true
                        resolve()
                    end
                end
            end)
        end
    end)
end

local function startServer(): any
    local services = ServiceModule._getAll()
    for _, service in services do
        ServiceModule._bindClient(service)
    end

    Network.CreateReadyMarker()

    Players.PlayerRemoving:Connect(function(player: Player)
        for _, service in services do
            local handler = service.OnPlayerRemoving
            if type(handler) == "function" then
                task.spawn(handler :: (any, Player) -> (), service, player)
            end
        end
    end)

    return runLifecycleStage(services, "OnInit"):andThen(function()
        return runLifecycleStage(services, "OnStart")
    end)
end

local function createClientRemotePropertyProxy(
    updateEvent: RemoteEvent,
    initFunc: RemoteFunction
): ClientRemotePropertyProxy
    local localSignal: Signal.Signal = Signal.new()
    local currentValue: any = nil
    local loaded: boolean = false

    local updateConn = updateEvent.OnClientEvent:Connect(function(value: any)
        currentValue = value
        loaded = true
        localSignal:Fire(value)
    end)

    task.spawn(function()
        local ok: boolean, value: any = pcall(function(): any
            return initFunc:InvokeServer()
        end)
        if ok and not loaded then
            currentValue = value
            loaded = true
            localSignal:Fire(value)
        end
    end)

    local proxy: ClientRemotePropertyProxy = {
        Get = function(_self: ClientRemotePropertyProxy): any
            if not loaded then
                localSignal:Wait()
            end
            return currentValue
        end,
        Observe = function(_self: ClientRemotePropertyProxy, fn: (value: any) -> ()): Signal.Connection
            local conn: Signal.Connection = localSignal:Connect(fn)
            if loaded then
                task.spawn(fn, currentValue)
            end
            return conn
        end,
        Destroy = function(_self: ClientRemotePropertyProxy): ()
            updateConn:Disconnect()
            localSignal:Destroy()
        end,
    }

    return proxy
end

local function buildClientServiceProxy(serviceName: string): ClientServiceProxy
    local proxy: ClientServiceProxy = { Name = serviceName }
    local ReplicatedStorage = game:GetService("ReplicatedStorage")
    local folder = ReplicatedStorage:FindFirstChild("SparkRemotes")

    if folder == nil or not folder:IsA("Folder") then
        return proxy
    end

    local f: Folder = folder :: Folder
    local pendingRPE: { [string]: RemoteEvent } = {}

    for _, child in f:GetChildren() do
        local parts: { string } = string.split(child.Name, "/")
        if #parts ~= 3 or parts[1] ~= serviceName then
            continue
        end

        local memberName: string = parts[2]
        local kind: string = parts[3]

        if kind == "RF" and child:IsA("RemoteFunction") then
            local remoteFunction: RemoteFunction = child :: RemoteFunction
            proxy[memberName] = function(_self: ClientServiceProxy, ...: any): any
                local argCount: number = select("#", ...)
                local argList: { any } = { ... }
                return Promise.new(function(resolve: (...any) -> (), reject: (...any) -> ())
                    local results = table.pack(pcall(function(): ...any
                        return remoteFunction:InvokeServer(table.unpack(argList, 1, argCount))
                    end))
                    local ok = results[1]
                    if ok then
                        resolve(table.unpack(results, 2, results.n))
                    else
                        reject(results[2])
                    end
                end)
            end
        elseif kind == "RE" and child:IsA("RemoteEvent") then
            local remoteEvent: RemoteEvent = child :: RemoteEvent
            local localSignal: Signal.Signal = Signal.new()
            remoteEvent.OnClientEvent:Connect(function(...: any)
                localSignal:Fire(...)
            end)
            proxy[memberName] = {
                Connect = function(_self: any, fn: (...any) -> ()): Signal.Connection
                    return localSignal:Connect(fn)
                end,
                Fire = function(_self: any, ...: any): ()
                    remoteEvent:FireServer(...)
                end,
            }
        elseif kind == "URE" and child:IsA("UnreliableRemoteEvent") then
            local remoteEvent: UnreliableRemoteEvent = child :: UnreliableRemoteEvent
            local localSignal: Signal.Signal = Signal.new()
            remoteEvent.OnClientEvent:Connect(function(...: any)
                localSignal:Fire(...)
            end)
            proxy[memberName] = {
                Connect = function(_self: any, fn: (...any) -> ()): Signal.Connection
                    return localSignal:Connect(fn)
                end,
                Fire = function(_self: any, ...: any): ()
                    remoteEvent:FireServer(...)
                end,
            }
        elseif kind == "RPE" and child:IsA("RemoteEvent") then
            pendingRPE[memberName] = child :: RemoteEvent
        end
    end

    for memberName, updateEvent in pendingRPE do
        local rpfKey: string = serviceName .. "/" .. memberName .. "/RPF"
        local rfChild = f:FindFirstChild(rpfKey)
        if rfChild ~= nil and rfChild:IsA("RemoteFunction") then
            proxy[memberName] = createClientRemotePropertyProxy(updateEvent, rfChild :: RemoteFunction)
        end
    end

    return proxy
end

function Spark.GetService(serviceName: string): ClientServiceProxy
    assert(IS_CLIENT, "[Spark] GetService can only be called on the client")
    assert(state ~= "Idle", "[Spark] GetService can only be called after Spark.Start()")

    local cached = clientServiceCache[serviceName]
    if cached ~= nil then
        return cached
    end

    local proxy = buildClientServiceProxy(serviceName)
    clientServiceCache[serviceName] = proxy
    return proxy
end

function Spark.GetController(controllerName: string): Controller
    assert(IS_CLIENT, "[Spark] GetController can only be called on the client")
    local controller = ControllerModule._getAll()[controllerName]
    assert(controller ~= nil, "[Spark] Controller not found: " .. controllerName)
    return controller
end

function Spark.GetServerService(serviceName: string): Service
    assert(IS_SERVER, "[Spark] GetServerService can only be called on the server")
    local service = ServiceModule._getAll()[serviceName]
    assert(service ~= nil, "[Spark] Service not found: " .. serviceName)
    return service
end

local function startClient(): any
    return Promise.new(function(resolve: (...any) -> (), _reject: (...any) -> ())
        Network.WaitForReady()
        resolve()
    end):andThen(function()
        local controllers = ControllerModule._getAll()
        return runLifecycleStage(controllers, "OnInit")
    end):andThen(function()
        local controllers = ControllerModule._getAll()
        return runLifecycleStage(controllers, "OnStart")
    end)
end

function Spark.Start(): any
    if startPromise ~= nil then
        return startPromise
    end

    assert(state == "Idle", "[Spark] Spark.Start() can only be called once")
    state = "Starting"

    ServiceModule._lock()
    ControllerModule._lock()

    local runner: any = if IS_SERVER then startServer() else startClient()

    startPromise = runner:andThen(function()
        state = "Running"
    end):catch(function(err: any)
        warn("[Spark] Startup failed: " .. tostring(err))
        return Promise.reject(err)
    end)

    return startPromise
end

function Spark.OnStart(): any
    if startPromise ~= nil then
        return startPromise
    end
    return Promise.reject("[Spark] Spark.Start() has not been called yet")
end

return Spark`
      }
    },

    m1: {
      name: 'M1 combat articulation',
      files: {
        'CombatHandler.lua': `--!strict
local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Shared = ReplicatedStorage:WaitForChild("Shared")
if not Shared or not Shared:IsA("Folder") then return end
local GameConfigModule = Shared:WaitForChild("GameConfig")
if not GameConfigModule or not GameConfigModule:IsA("ModuleScript") then return end
local GameConfig = require(GameConfigModule)
local HitboxSystemModule = script.Parent:WaitForChild("HitboxSystem")
if not HitboxSystemModule or not HitboxSystemModule:IsA("ModuleScript") then return end
local HitboxSystem = require(HitboxSystemModule)
local VFXSystemModule = script.Parent:WaitForChild("VFXSystem")
if not VFXSystemModule or not VFXSystemModule:IsA("ModuleScript") then return end
local VFXSystem = require(VFXSystemModule)
local combatEvent = Instance.new("RemoteEvent")
combatEvent.Name = "CombatEvent"
combatEvent.Parent = ReplicatedStorage
local cooldowns: {[Player]: number} = {}
Players.PlayerRemoving:Connect(function(player: Player): ()
	cooldowns[player] = nil
end)
combatEvent.OnServerEvent:Connect(function(player: Player, action: unknown, isRunning: unknown): ()
	if typeof(action) ~= "string" or typeof(isRunning) ~= "boolean" then return end
	if action ~= "M1" and action ~= "M2" then return end
	local now: number = os.clock()
	local last: number = cooldowns[player] or 0
	if now - last < GameConfig.Combat.COOLDOWN then return end
	local character = player.Character
	if not character or not character:IsA("Model") then return end
	local humanoid = character:FindFirstChildOfClass("Humanoid")
	if not humanoid then return end
	local rootPart = character:FindFirstChild("HumanoidRootPart")
	if not rootPart or not rootPart:IsA("BasePart") then return end
	if humanoid.Health <= 0 then return end
	cooldowns[player] = now
	local isM1: boolean = (action == "M1")
	local runBonus: boolean = isRunning == true
	task.delay(GameConfig.Combat.VFX_DELAY, function(): ()
		if not character.Parent or not rootPart.Parent or humanoid.Health <= 0 then return end
		VFXSystem.PlayComboVFX(rootPart, isM1)
		HitboxSystem.CreateHitbox(character, rootPart, runBonus)
	end)
end)`,

        'CombatController.lua': `--!strict
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local UserInputService = game:GetService("UserInputService")
local Shared = ReplicatedStorage:WaitForChild("Shared")
if not Shared or not Shared:IsA("Folder") then return end
local GameConfigModule = Shared:WaitForChild("GameConfig")
if not GameConfigModule or not GameConfigModule:IsA("ModuleScript") then return end
local GameConfig = require(GameConfigModule)
local MaidModule = Shared:WaitForChild("Maid")
if not MaidModule or not MaidModule:IsA("ModuleScript") then return end
local Maid = require(MaidModule)
local AnimationControllerModule = Shared:WaitForChild("AnimationController")
if not AnimationControllerModule or not AnimationControllerModule:IsA("ModuleScript") then return end
local AnimationController = require(AnimationControllerModule)
local character = script.Parent
if not character or not character:IsA("Model") then return end
local humanoid = character:WaitForChild("Humanoid")
if not humanoid or not humanoid:IsA("Humanoid") then return end
local animator = humanoid:WaitForChild("Animator")
if not animator or not animator:IsA("Animator") then return end
local combatEvent = ReplicatedStorage:WaitForChild("CombatEvent")
if not combatEvent or not combatEvent:IsA("RemoteEvent") then return end
humanoid:SetStateEnabled(Enum.HumanoidStateType.Jumping, false)
local maid = Maid.new()
local attackMaid = Maid.new()
local animController = AnimationController.new(animator, GameConfig.Animations)
local running: boolean = false
local attacking: boolean = false
local airborne: boolean = false
local isDestroyed: boolean = false
humanoid.WalkSpeed = GameConfig.Speed.WALK
local ownTracks: {[AnimationTrack]: boolean} = {}
for _, track: AnimationTrack in pairs(animController:GetAllTracks()) do
	ownTracks[track] = true
end
maid:GiveTask(animator.AnimationPlayed:Connect(function(track: AnimationTrack): ()
	if not ownTracks[track] then
		track:Stop(0)
	end
end))
animController:PlayTrack("idle", 0.1)
local function updateState(blendTime: number?): ()
	if attacking or airborne or isDestroyed then return end
	local target: string = "idle"
	if humanoid.MoveDirection.Magnitude > 0 then
		target = if running then "run" else "walk"
	end
	if animController:GetCurrentName() ~= target then
		animController:PlayTrack(target, blendTime or 0.2)
	end
end
local comboToggle: boolean = false
local lastComboTime: number = 0
local function executeAttack(): ()
	if attacking or isDestroyed or humanoid.Health <= 0 or airborne then return end
	if os.clock() - lastComboTime > GameConfig.Combat.COMBO_RESET_WINDOW then
		comboToggle = false
	end
	local actionName: string = if comboToggle then "M2" else "M1"
	local trackName: string = string.lower(actionName)
	local track = animController:GetTrack(trackName)
	if not track then return end
	attacking = true
	humanoid.WalkSpeed = GameConfig.Speed.ATTACK
	animController:PlayTrack(trackName, 0.1)
	combatEvent:FireServer(actionName, running)
	attackMaid:DoCleaning()
	attackMaid:GiveTask(track.Stopped:Once(function(): ()
		attackMaid:DoCleaning()
		if isDestroyed then return end
		attacking = false
		if airborne then
			comboToggle = false
		else
			comboToggle = not comboToggle
			lastComboTime = os.clock()
		end
		if humanoid.Health > 0 then
			humanoid.WalkSpeed = if running then GameConfig.Speed.RUN else GameConfig.Speed.WALK
			updateState(0.1)
		end
	end))
end
maid:GiveTask(humanoid:GetPropertyChangedSignal("MoveDirection"):Connect(function(): ()
	updateState()
end))
maid:GiveTask(humanoid.StateChanged:Connect(function(_: Enum.HumanoidStateType, newState: Enum.HumanoidStateType): ()
	airborne = (newState == Enum.HumanoidStateType.Freefall or newState == Enum.HumanoidStateType.Jumping or newState == Enum.HumanoidStateType.FallingDown or newState == Enum.HumanoidStateType.Ragdoll)
	if airborne then
		animController:StopCurrent(0.2)
	else
		updateState(0.1)
	end
end))
maid:GiveTask(UserInputService.InputBegan:Connect(function(input: InputObject, gp: boolean): ()
	if gp or humanoid.Health <= 0 or isDestroyed then return end
	if input.KeyCode == Enum.KeyCode.LeftShift then
		running = true
		if not attacking then
			humanoid.WalkSpeed = GameConfig.Speed.RUN
			updateState()
		end
	elseif input.UserInputType == Enum.UserInputType.MouseButton1 then
		executeAttack()
	end
end))
maid:GiveTask(UserInputService.InputEnded:Connect(function(input: InputObject): ()
	if isDestroyed then return end
	if input.KeyCode == Enum.KeyCode.LeftShift then
		running = false
		if not attacking then
			humanoid.WalkSpeed = GameConfig.Speed.WALK
			updateState()
		end
	end
end))
local function destroy(): ()
	if isDestroyed then return end
	isDestroyed = true
	comboToggle = false
	attackMaid:DoCleaning()
	maid:DoCleaning()
	animController:Destroy()
end
maid:GiveTask(humanoid.Died:Connect(destroy))
maid:GiveTask(character.Destroying:Connect(destroy))`,

        'HitboxSystem.lua': `--!strict
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Shared = ReplicatedStorage:WaitForChild("Shared")
if not Shared or not Shared:IsA("Folder") then return {} end
local GameConfigModule = Shared:WaitForChild("GameConfig")
if not GameConfigModule or not GameConfigModule:IsA("ModuleScript") then return {} end
local GameConfig = require(GameConfigModule)
local VFXSystemModule = script.Parent:WaitForChild("VFXSystem")
if not VFXSystemModule or not VFXSystemModule:IsA("ModuleScript") then return {} end
local VFXSystem = require(VFXSystemModule)
local hitboxTemplate = ReplicatedStorage:WaitForChild("Hitbox")
if not hitboxTemplate or not hitboxTemplate:IsA("BasePart") then return {} end
local HitboxSystem = {}
function HitboxSystem.CreateHitbox(attackerChar: Model, attackerRoot: BasePart, runBonus: boolean): ()
	local hitbox = hitboxTemplate:Clone()
	if not hitbox or not hitbox:IsA("BasePart") then return end
	hitbox.CanQuery = false
	hitbox.CanTouch = true
	local weld = Instance.new("Weld")
	weld.Part0 = attackerRoot
	weld.Part1 = hitbox
	weld.C1 = CFrame.new(0, 0, 3)
	weld.Parent = hitbox
	hitbox.Parent = attackerRoot
	local hitList: {[Humanoid]: boolean} = {}
	local conn: RBXScriptConnection
	conn = hitbox.Touched:Connect(function(hit: BasePart): ()
		if not hit or not hit.Parent then return end
		local enemyChar = hit.Parent
		if not enemyChar:IsA("Model") or enemyChar == attackerChar then return end
		local eHum = enemyChar:FindFirstChildOfClass("Humanoid")
		if not eHum then return end
		local eRoot = enemyChar:FindFirstChild("HumanoidRootPart")
		if not eRoot or not eRoot:IsA("BasePart") then return end
		if eHum.Health <= 0 or hitList[eHum] then return end
		hitList[eHum] = true
		local dmg: number = if runBonus then GameConfig.Combat.DAMAGE * GameConfig.Combat.RUN_DAMAGE_MULT else GameConfig.Combat.DAMAGE
		local kb: number = if runBonus then GameConfig.Combat.KNOCKBACK * GameConfig.Combat.RUN_KNOCKBACK_MULT else GameConfig.Combat.KNOCKBACK
		if eHum:GetAttribute("Immortal") then
			eHum.Health = math.max(eHum.Health - dmg, 1)
		else
			eHum:TakeDamage(dmg)
		end
		VFXSystem.PlayHitVFX(enemyChar)
		VFXSystem.ApplyKnockback(attackerRoot, eRoot, kb)
	end)
	task.delay(GameConfig.Combat.HITBOX_ACTIVE, function(): ()
		if conn and conn.Connected then conn:Disconnect() end
		if hitbox then hitbox:Destroy() end
	end)
end
return table.freeze(HitboxSystem)`,

        'VFXSystem.lua': `--!strict
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local TweenService = game:GetService("TweenService")
local Shared = ReplicatedStorage:WaitForChild("Shared")
if not Shared or not Shared:IsA("Folder") then return {} end
local GameConfigModule = Shared:WaitForChild("GameConfig")
if not GameConfigModule or not GameConfigModule:IsA("ModuleScript") then return {} end
local GameConfig = require(GameConfigModule)
local combo1 = ReplicatedStorage:WaitForChild("combo1")
if not combo1 then return {} end
local combo2 = ReplicatedStorage:WaitForChild("combo2")
if not combo2 then return {} end
local VFXSystem = {}
function VFXSystem.PlayComboVFX(rootPart: BasePart, isM1: boolean): ()
	local template = if isM1 then combo1 else combo2
	local vfx = template:Clone()
	if not vfx then return end
	vfx.Parent = rootPart
	local emitters: {ParticleEmitter} = {}
	for _, obj in ipairs(vfx:GetDescendants()) do
		if obj:IsA("ParticleEmitter") then
			table.insert(emitters, obj)
			obj.Enabled = true
		end
	end
	task.delay(GameConfig.Combat.VFX_EMIT_DURATION, function(): ()
		for _, emitter in ipairs(emitters) do
			emitter.Enabled = false
		end
	end)
	task.delay(GameConfig.Combat.VFX_LIFETIME, function(): ()
		if vfx then vfx:Destroy() end
	end)
end
function VFXSystem.PlayHitVFX(enemyChar: Model): ()
	local highlight = Instance.new("Highlight")
	highlight.FillColor = Color3.fromRGB(255, 0, 0)
	highlight.OutlineColor = Color3.fromRGB(255, 255, 255)
	highlight.FillTransparency = 1
	highlight.OutlineTransparency = 1
	highlight.DepthMode = Enum.HighlightDepthMode.Occluded
	highlight.Parent = enemyChar
	local tweenIn = TweenService:Create(highlight, TweenInfo.new(0.05, Enum.EasingStyle.Quad, Enum.EasingDirection.Out), {FillTransparency = 0.25})
	local tweenOut = TweenService:Create(highlight, TweenInfo.new(0.15, Enum.EasingStyle.Quad, Enum.EasingDirection.Out), {FillTransparency = 1})
	tweenIn.Completed:Once(function(): ()
		tweenOut:Play()
	end)
	tweenIn:Play()
	task.delay(GameConfig.Combat.HIGHLIGHT_DURATION, function(): ()
		if highlight then highlight:Destroy() end
	end)
end
function VFXSystem.ApplyKnockback(attackerRoot: BasePart, enemyRoot: BasePart, force: number): ()
	local clampedForce: number = math.clamp(force, 0, GameConfig.Combat.MAX_KNOCKBACK_FORCE)
	local att = Instance.new("Attachment")
	att.Parent = enemyRoot
	local lv = Instance.new("LinearVelocity")
	lv.Attachment0 = att
	lv.VectorVelocity = attackerRoot.CFrame.LookVector * clampedForce + Vector3.new(0, 10, 0)
	lv.MaxForce = math.huge
	lv.RelativeTo = Enum.ActuatorRelativeTo.World
	lv.Parent = enemyRoot
	task.delay(GameConfig.Combat.KNOCKBACK_DURATION, function(): ()
		if lv then lv:Destroy() end
		if att then att:Destroy() end
	end)
end
return table.freeze(VFXSystem)`,

        'AnimationController.lua': `--!strict
local AnimationController = {}
AnimationController.__index = AnimationController
type TrackMap = {[string]: AnimationTrack}
export type AnimationController = typeof(setmetatable({} :: { _tracks: TrackMap, _current: string }, AnimationController))
local PRIORITIES: {[string]: Enum.AnimationPriority} = {idle = Enum.AnimationPriority.Idle, walk = Enum.AnimationPriority.Movement, run = Enum.AnimationPriority.Movement, m1 = Enum.AnimationPriority.Action, m2 = Enum.AnimationPriority.Action}
local LOOPED: {[string]: boolean} = {idle = true, walk = true, run = true, m1 = false, m2 = false}
function AnimationController.new(animator: Animator, ids: {[string]: string}): AnimationController
	local tracks: TrackMap = {}
	for key: string, id: string in pairs(ids) do
		local name: string = string.lower(key)
		local anim: Animation = Instance.new("Animation")
		anim.AnimationId = id
		local track: AnimationTrack = animator:LoadAnimation(anim)
		anim:Destroy()
		if PRIORITIES[name] then track.Priority = PRIORITIES[name] end
		if LOOPED[name] ~= nil then track.Looped = LOOPED[name] end
		tracks[name] = track
	end
	return setmetatable({ _tracks = tracks, _current = "" }, AnimationController)
end
function AnimationController.PlayTrack(self: AnimationController, name: string, blendTime: number?): ()
	local track: AnimationTrack? = self._tracks[name]
	if not track then return end
	if self._current ~= "" and self._current ~= name then
		local prev: AnimationTrack? = self._tracks[self._current]
		if prev and prev.IsPlaying then
			prev:Stop(blendTime or 0.2)
		end
	end
	self._current = name
	track:Play(blendTime or 0.2)
end
function AnimationController.StopCurrent(self: AnimationController, blendTime: number?): ()
	if self._current == "" then return end
	local track: AnimationTrack? = self._tracks[self._current]
	if track and track.IsPlaying then
		track:Stop(blendTime or 0.2)
	end
	self._current = ""
end
function AnimationController.GetTrack(self: AnimationController, name: string): AnimationTrack?
	return self._tracks[name]
end
function AnimationController.GetCurrentName(self: AnimationController): string
	return self._current
end
function AnimationController.GetAllTracks(self: AnimationController): TrackMap
	return self._tracks
end
function AnimationController.Destroy(self: AnimationController): ()
	for _, track: AnimationTrack in pairs(self._tracks) do
		if track.IsPlaying then track:Stop(0) end
		track:Destroy()
	end
	table.clear(self._tracks)
	self._current = ""
end
return table.freeze(AnimationController)`,

        'Maid.lua': `--!strict
local Maid = {}
Maid.__index = Maid
export type Task = RBXScriptConnection | Instance | () -> () | thread
export type Maid = typeof(setmetatable({} :: { _tasks: {Task} }, Maid))
function Maid.new(): Maid
	return setmetatable({ _tasks = {} }, Maid)
end
function Maid.GiveTask(self: Maid, taskItem: Task): Task
	table.insert(self._tasks, taskItem)
	return taskItem
end
function Maid.DoCleaning(self: Maid): ()
	local tasks: {Task} = self._tasks
	self._tasks = {}
	for _, item: Task in ipairs(tasks) do
		local tt: string = typeof(item)
		if tt == "RBXScriptConnection" then
			(item :: RBXScriptConnection):Disconnect()
		elseif tt == "Instance" then
			(item :: Instance):Destroy()
		elseif tt == "function" then
			(item :: () -> ())()
		elseif tt == "thread" then
			if coroutine.status(item :: thread) ~= "dead" then
				task.cancel(item :: thread)
			end
		end
	end
end
return table.freeze(Maid)`,

        'GameConfig.lua': `--!strict
export type CombatConfig = {DAMAGE: number, KNOCKBACK: number, MAX_KNOCKBACK_FORCE: number, COOLDOWN: number, VFX_DELAY: number, VFX_EMIT_DURATION: number, VFX_LIFETIME: number, HITBOX_ACTIVE: number, KNOCKBACK_DURATION: number, HIGHLIGHT_DURATION: number, RUN_DAMAGE_MULT: number, RUN_KNOCKBACK_MULT: number, COMBO_RESET_WINDOW: number}
export type SpeedConfig = {WALK: number, RUN: number, ATTACK: number}
export type AnimationIds = {IDLE: string, WALK: string, RUN: string, M1: string, M2: string}
local GameConfig = {}
GameConfig.Combat = table.freeze({DAMAGE = 25, KNOCKBACK = 40, MAX_KNOCKBACK_FORCE = 120, COOLDOWN = 0.4, VFX_DELAY = 0.25, VFX_EMIT_DURATION = 0.3, VFX_LIFETIME = 1, HITBOX_ACTIVE = 0.35, KNOCKBACK_DURATION = 0.15, HIGHLIGHT_DURATION = 0.3, RUN_DAMAGE_MULT = 1.2, RUN_KNOCKBACK_MULT = 1.35, COMBO_RESET_WINDOW = 1}) :: CombatConfig
GameConfig.Speed = table.freeze({WALK = 12, RUN = 20, ATTACK = 0}) :: SpeedConfig
GameConfig.Animations = table.freeze({IDLE = "rbxassetid://100543849291511", WALK = "rbxassetid://108096244047063", RUN = "rbxassetid://91574816420777", M1 = "rbxassetid://98255810475707", M2 = "rbxassetid://119644330061039"}) :: AnimationIds
return table.freeze(GameConfig)`,

        'Animate.lua': `--!strict
`,

        'readme.md': `# 📁 Project Structure
\`\`\`
ReplicatedStorage/
├── AnimationGraphEditor/
├── Shared/
│   ├── AnimationController       ← ModuleScript
│   ├── GameConfig                ← ModuleScript
│   └── Maid                      ← ModuleScript
├── combo1                        ← RemoteEvent
├── combo2                        ← RemoteEvent
└── Hitbox                        ← Part

ServerScriptService/
├── CombatHandler                 ← Script
├── HitboxSystem                  ← ModuleScript
└── VFXSystem                     ← ModuleScript

StarterPlayer/
├── StarterCharacter/
├── StarterCharacterScripts/
│   ├── Animate                   ← LocalScript
│   └── CombatController          ← LocalScript
└── StarterPlayerScripts/
\`\`\``
      }
    }
  };

  function initNav() {
    const nav = $('#nav');
    if (!nav) return;

    let ticking = false;
    const onScroll = () => {
      nav.classList.toggle('scrolled', window.scrollY > 28);
      ticking = false;
    };

    window.addEventListener('scroll', () => {
      if (!ticking) {
        requestAnimationFrame(onScroll);
        ticking = true;
      }
    }, { passive: true });
    onScroll();
  }

  function initDrawer() {
    const menuBtn = $('#menuBtn');
    const drawer = $('#drawer');
    const overlay = $('#drawerOverlay');
    const closeBtn = $('#drawerClose');
    if (!menuBtn || !drawer || !overlay) return;

    function openDrawer() {
      drawer.classList.add('open');
      overlay.classList.add('open');
      document.body.style.overflow = 'hidden';
    }

    function closeDrawer() {
      drawer.classList.remove('open');
      overlay.classList.remove('open');
      document.body.style.overflow = '';
    }

    menuBtn.addEventListener('click', openDrawer);
    if (closeBtn) closeBtn.addEventListener('click', closeDrawer);
    overlay.addEventListener('click', closeDrawer);

    $$('.drawer__link').forEach(link => {
      link.addEventListener('click', closeDrawer);
    });
  }

  function initScrollReveal() {
    const items = $$('.reveal-el');
    if (!items.length) return;

    const grids = $$('.sys-grid, .demos-grid, .sk-grid, .pay-grid, .info-grid, .scope-row');
    grids.forEach(grid => {
      $$('.reveal-el', grid).forEach((el, i) => {
        el.style.transitionDelay = (i * 0.06) + 's';
      });
    });

    const heroItems = $$('.hero__inner .reveal-el');
    heroItems.forEach((el, i) => {
      if (!el.style.transitionDelay) {
        el.style.transitionDelay = `${i * 120}ms`;
      }
    });

    const io = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.add('revealed');
        io.unobserve(entry.target);
      }
    }, { threshold: 0.08, rootMargin: '0px 0px -50px 0px' });

    items.forEach(el => io.observe(el));
  }

  function initCodePreview() {
    const overlay  = $('#codeModalOverlay');
    const titleEl  = $('#codeModalTitle');
    const closeBtn = $('#codeModalClose');
    const sidebar  = $('#codeModalSidebar');
    const panel    = $('#codeModalCodePanel');
    const tabsEl   = $('#codeModalTabs');

    if (!overlay || !panel || !titleEl || !closeBtn || !sidebar) return;

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

    function selectFile(items, tabs, idx, proj, names) {
      items.forEach(el => el.classList.remove('active'));
      tabs.forEach(el => el.classList.remove('active'));
      if (items[idx]) items[idx].classList.add('active');
      if (tabs[idx]) tabs[idx].classList.add('active');
      renderFile(proj.files[names[idx]]);
    }

    function openModal(key) {
      const proj = projectFiles[key];
      if (!proj) return;

      const names = Object.keys(proj.files);
      titleEl.textContent = proj.name;

      sidebar.innerHTML = '<div class="code-modal__sidebar-section">Explorer</div>';
      if (tabsEl) tabsEl.innerHTML = '';

      const items = [];
      const tabs  = [];

      names.forEach((name, idx) => {
        const item = document.createElement('div');
        item.className = 'code-modal__file-item' + (idx === 0 ? ' active' : '');

        const icon = document.createElement('div');
        icon.className = 'code-modal__file-icon';
        const nameSpan = document.createElement('span');
        nameSpan.className = 'code-modal__file-name';
        nameSpan.textContent = name;
        item.appendChild(icon);
        item.appendChild(nameSpan);
        item.addEventListener('click', () => selectFile(items, tabs, idx, proj, names));
        sidebar.appendChild(item);
        items.push(item);

        if (tabsEl) {
          const tab = document.createElement('div');
          tab.className = 'code-modal__tab' + (idx === 0 ? ' active' : '');
          const dot = document.createElement('span');
          dot.className = 'code-modal__tab-dot';
          tab.appendChild(dot);
          tab.appendChild(document.createTextNode(name));
          tab.addEventListener('click', () => selectFile(items, tabs, idx, proj, names));
          tabsEl.appendChild(tab);
          tabs.push(tab);
        }
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

  function initActiveNav() {
    const sections = $$('section[id]');
    const links = $$('.nav__link');
    if (!sections.length || !links.length) return;
    const obs = new IntersectionObserver(entries => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          const id = entry.target.id;
          links.forEach(l => {
            l.classList.toggle('active', l.getAttribute('href') === '#' + id);
          });
        }
      });
    }, { rootMargin: '-40% 0px -55% 0px', threshold: 0 });
    sections.forEach(s => obs.observe(s));
  }

  function initThemeToggle() {
    const btn = $('#themeToggle');
    if (!btn) return;
    const icon = $('i', btn);
    const root = document.documentElement;
    const STORAGE_KEY = 'theme';

    function applyState(theme) {
      if (icon) icon.className = theme === 'dark' ? 'fa-solid fa-sun' : 'fa-solid fa-moon';
      btn.setAttribute('aria-pressed', theme === 'dark' ? 'true' : 'false');
      btn.setAttribute('aria-label', theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme');
    }

    applyState(root.getAttribute('data-theme') === 'dark' ? 'dark' : 'light');

    btn.addEventListener('click', () => {
      const next = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      if (next === 'dark') {
        root.setAttribute('data-theme', 'dark');
      } else {
        root.removeAttribute('data-theme');
      }
      try {
        localStorage.setItem(STORAGE_KEY, next);
      } catch (e) {}
      applyState(next);
    });
  }

  function initDiscordCopy() {
    const btn = $('#discordBtn');
    if (!btn) return;

    let toast = document.querySelector('.toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.className = 'toast';
      toast.innerHTML = '<i class="fa-solid fa-check"></i> Discord copied to clipboard!';
      document.body.appendChild(toast);
    }

    let tOut;
    btn.addEventListener('click', () => {
      navigator.clipboard.writeText('x90xcs').then(() => {
        toast.classList.add('show');
        if (tOut) clearTimeout(tOut);
        tOut = setTimeout(() => {
          toast.classList.remove('show');
        }, 2500);
      }).catch(err => {
        console.error('Failed to copy: ', err);
      });
    });
  }

  initNav();
  initDrawer();
  initScrollReveal();
  initCodePreview();
  initActiveNav();
  initThemeToggle();
  initDiscordCopy();
})();
