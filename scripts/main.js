(function () {
  'use strict';

  const $  = (sel, ctx) => (ctx || document).querySelector(sel);
  const $$ = (sel, ctx) => Array.from((ctx || document).querySelectorAll(sel));

  const projectFiles = {
    'drag-throw': {
      name: 'Dead rails - drag, weight & throw',
      files: {
        'DragService.lua': `--!strict

local CollectionService = game:GetService("CollectionService")
local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local RunService = game:GetService("RunService")

local Shared = ReplicatedStorage:WaitForChild("Shared")
local Config = require(Shared:WaitForChild("GameConfig"))

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
local eDragDenied = remotes:WaitForChild("DragDenied") :: RemoteEvent

local activeDrags: { [Player]: DragState } = {}
local playerAttachments: { [Player]: Attachment } = {}

local draggablesFolder = workspace:WaitForChild(Config.DraggablesFolderName)

for _, partName in Config.DraggableNames do
	local found = draggablesFolder:FindFirstChild(partName)
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
	if state.alignOrientation then state.alignOrientation:Destroy() end
	if state.alignPosition then state.alignPosition:Destroy() end
	if state.partAttachment then state.partAttachment:Destroy() end
	if state.part and state.part.Parent then
		state.part:SetAttribute(Config.OwnerAttribute, nil)
	end
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
	if part and part.Parent and not part.Anchored then
		if throwVelocity ~= nil and throwVelocity.Magnitude == throwVelocity.Magnitude then
			applyThrow(part, throwVelocity)
		end
		pcall(function()
			part:SetNetworkOwnershipAuto()
		end)
	end
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

for _, player in Players:GetPlayers() do
	onPlayerAdded(player)
end

Players.PlayerAdded:Connect(onPlayerAdded)
Players.PlayerRemoving:Connect(onPlayerRemoving)

eDragStart.OnServerEvent:Connect(function(player: Player, rawPart: any)
	if activeDrags[player] ~= nil then return end
	if typeof(rawPart) ~= "Instance" then return end
	if not rawPart:IsA("BasePart") then return end
	if not CollectionService:HasTag(rawPart, Config.Tag) then return end
	if rawPart.Parent == nil or rawPart.Anchored then return end

	local dragAtt: Attachment? = playerAttachments[player]
	if dragAtt == nil then return end

	local part: BasePart = rawPart :: BasePart

	if part:GetAttribute(Config.OwnerAttribute) ~= nil then
		eDragDenied:FireClient(player)
		return
	end

	local character = player.Character
	local rootPart = character and character.PrimaryPart
	if rootPart == nil then return end
	if (rootPart.Position - part.Position).Magnitude > Config.MaxGrabDistance then
		eDragDenied:FireClient(player)
		return
	end

	part:SetAttribute(Config.OwnerAttribute, player.UserId)
	local ok: boolean = pcall(function()
		part:SetNetworkOwner(player)
	end)
	if not ok then
		part:SetAttribute(Config.OwnerAttribute, nil)
		return
	end

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
	for player, state in activeDrags do
		if state == nil then continue end
		if not state.part or state.part.Parent == nil or state.part.Anchored then
			pcall(teardownConstraints, state)
			table.insert(toRemove, player)
			continue
		end
		local ok: boolean = pcall(function()
			if state.part:GetNetworkOwner() ~= player then
				state.part:SetNetworkOwner(player)
			end
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

        'DragController.lua': `--!strict

local CollectionService = game:GetService("CollectionService")
local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local RunService = game:GetService("RunService")
local UserInputService = game:GetService("UserInputService")

local Shared = ReplicatedStorage:WaitForChild("Shared")
local Config = require(Shared:WaitForChild("GameConfig"))

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

local highlight: Highlight = Instance.new("Highlight")
highlight.OutlineColor = Config.HighlightColor
highlight.OutlineTransparency = Config.HighlightOutlineTransparency
highlight.FillTransparency = Config.HighlightFillTransparency
highlight.DepthMode = Enum.HighlightDepthMode.Occluded
highlight.Adornee = nil
highlight.Enabled = false
highlight.Parent = workspace

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
	highlight.Adornee = part
	highlight.Enabled = part ~= nil
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

        'FootstepService.lua': `--!strict

local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local ServerStorage = game:GetService("ServerStorage")
local TweenService = game:GetService("TweenService")

local Shared = ReplicatedStorage:WaitForChild("Shared")
local Config = require(Shared:WaitForChild("GameConfig"))

local audio = ServerStorage:WaitForChild("Audio")
local footstepTemplate = audio:WaitForChild(Config.FootstepSoundName) :: Sound

local remotes = ReplicatedStorage:WaitForChild("Remotes") :: Folder
local eFootstepState = remotes:WaitForChild("FootstepState") :: RemoteEvent

type FootstepState = {
	sound: Sound,
	fullVolume: number,
	isRunning: boolean,
	tween: Tween?,
}

local states: { [Player]: FootstepState } = {}

local function onCharacterAdded(player: Player, character: Model): ()
	local rootPart = character:WaitForChild("HumanoidRootPart") :: BasePart
	local existing = rootPart:FindFirstChild(Config.FootstepSoundName)
	if existing ~= nil then existing:Destroy() end

	local sound: Sound = footstepTemplate:Clone()
	sound.Looped = true
	sound.Playing = false
	local fullVolume: number = sound.Volume
	sound.Volume = 0
	sound.Parent = rootPart

	states[player] = {
		sound = sound,
		fullVolume = fullVolume,
		isRunning = false,
		tween = nil,
	}
end

local function setRunning(player: Player, running: boolean): ()
	local state = states[player]
	if state == nil then return end
	if state.isRunning == running then return end
	state.isRunning = running

	if state.tween ~= nil then
		state.tween:Cancel()
		state.tween = nil
	end

	if running then
		if not state.sound.Playing then
			state.sound:Play()
		end
		local tween: Tween = TweenService:Create(state.sound, TweenInfo.new(Config.FootstepFadeTime, Enum.EasingStyle.Linear), { Volume = state.fullVolume })
		state.tween = tween
		tween:Play()
	else
		local tween: Tween = TweenService:Create(state.sound, TweenInfo.new(Config.FootstepFadeTime, Enum.EasingStyle.Linear), { Volume = 0 })
		state.tween = tween
		local connection: RBXScriptConnection? = nil
		connection = tween.Completed:Connect(function(playbackState: Enum.PlaybackState)
			if connection ~= nil then
				connection:Disconnect()
			end
			if playbackState == Enum.PlaybackState.Completed then
				state.sound:Stop()
			end
		end)
		tween:Play()
	end
end

local function onPlayerAdded(player: Player): ()
	player.CharacterAdded:Connect(function(character: Model)
		onCharacterAdded(player, character)
	end)
	local character: Model? = player.Character
	if character ~= nil then
		onCharacterAdded(player, character)
	end
end

local function onPlayerRemoving(player: Player): ()
	states[player] = nil
end

for _, player in Players:GetPlayers() do
	onPlayerAdded(player)
end

Players.PlayerAdded:Connect(onPlayerAdded)
Players.PlayerRemoving:Connect(onPlayerRemoving)

eFootstepState.OnServerEvent:Connect(function(player: Player, rawRunning: any)
	if typeof(rawRunning) ~= "boolean" then return end
	setRunning(player, rawRunning)
end)`,

        'FootstepController.lua': `--!strict

local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")

local Shared = ReplicatedStorage:WaitForChild("Shared")
local Config = require(Shared:WaitForChild("GameConfig"))

local remotes = ReplicatedStorage:WaitForChild("Remotes") :: Folder
local eFootstepState = remotes:WaitForChild("FootstepState") :: RemoteEvent

local localPlayer: Player = Players.LocalPlayer

local isRunning: boolean = false

local function setupCharacter(character: Model): ()
	local humanoid = character:WaitForChild("Humanoid") :: Humanoid
	isRunning = false

	humanoid.Running:Connect(function(speed: number)
		local running: boolean = speed > Config.FootstepMinSpeed
		if running == isRunning then return end
		isRunning = running
		eFootstepState:FireServer(running)
	end)
end

local character: Model = (localPlayer.Character or localPlayer.CharacterAdded:Wait()) :: Model
setupCharacter(character)

localPlayer.CharacterAdded:Connect(setupCharacter)
`,

        'CameraController.lua': `--!strict

local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")

local Shared = ReplicatedStorage:WaitForChild("Shared")
local Config = require(Shared:WaitForChild("GameConfig"))

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

        'CrosshairController.lua': `--!strict

local GuiService = game:GetService("GuiService")
local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local UserInputService = game:GetService("UserInputService")

local Shared = ReplicatedStorage:WaitForChild("Shared")
local Config = require(Shared:WaitForChild("GameConfig"))

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
end)`,

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

Config.HighlightColor = Color3.fromRGB(255, 255, 255)
Config.HighlightFillTransparency = 1
Config.HighlightOutlineTransparency = 0

Config.FootstepSoundName = "RunningFootsteps"
Config.FootstepMinSpeed = 0.5
Config.FootstepFadeTime = 0.2

Config.CameraMode = Enum.CameraMode.LockFirstPerson
Config.FirstPersonFieldOfView = 100

Config.CrosshairColor = Color3.fromRGB(255, 255, 255)
Config.CrosshairSize = 4

Config.DraggablesFolderName = "Draggables"
Config.DraggableNames = { "Duck1", "Duck2", "Duck3" } :: { string }
Config.InitialWeights = { Duck1 = 1, Duck2 = 3, Duck3 = 8 } :: { [string]: number }

function Config.GetWeight(part: BasePart): number
	local raw = part:GetAttribute(Config.WeightAttribute)
	local value: number = tonumber(raw) or Config.DefaultWeight
	return math.clamp(value, Config.MinWeight, Config.MaxWeight)
end

return Config`,

        'readme.md': `# 📁 Project Structure
\`\`\`
ReplicatedStorage/
├── Shared/
│   └── GameConfig            ← ModuleScript
└── Remotes/
    ├── DragStart              ← RemoteEvent
    ├── DragEnd                ← RemoteEvent
    ├── DragDenied             ← RemoteEvent
    └── FootstepState          ← RemoteEvent

ServerScriptService/
├── DragService                ← Script
└── FootstepService             ← Script

ServerStorage/
└── Audio/                     
    └── RunningFootsteps        ← Sound

StarterPlayer/
└── StarterPlayerScripts/
    ├── DragController          ← LocalScript
    ├── CrosshairController     ← LocalScript
    ├── CameraController        ← LocalScript
    └── FootstepController      ← LocalScript

Workspace/
└── Draggables/                 
    ├── Duck1                   ← MeshPart
    ├── Duck2                   ← Part
    └── Duck3                   ← MeshPart
\`\`\``
      }
    },

    m1: {
      name: 'Simple combat system',
      files: {
        'CombatHandler.lua': `--!strict
local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local TweenService = game:GetService("TweenService")
local Shared = ReplicatedStorage:WaitForChild("Shared")
if not Shared or not Shared:IsA("Folder") then return end
local GameConfigModule = Shared:WaitForChild("GameConfig")
if not GameConfigModule or not GameConfigModule:IsA("ModuleScript") then return end
local GameConfig = require(GameConfigModule)
local AnimationControllerModule = Shared:WaitForChild("AnimationController")
if not AnimationControllerModule or not AnimationControllerModule:IsA("ModuleScript") then return end
local AnimationController = require(AnimationControllerModule)
local hitboxTemplate = ReplicatedStorage:WaitForChild(GameConfig.Assets.HITBOX)
if not hitboxTemplate or not hitboxTemplate:IsA("BasePart") then return end
local slashM1 = ReplicatedStorage:WaitForChild(GameConfig.Assets.SLASH_EFFECT_M1)
if not slashM1 then return end
local slashM2 = ReplicatedStorage:WaitForChild(GameConfig.Assets.SLASH_EFFECT_M2)
if not slashM2 then return end
local hitImpactSound = ReplicatedStorage:WaitForChild(GameConfig.Assets.HIT_IMPACT_SOUND)
if not hitImpactSound or not hitImpactSound:IsA("Sound") then return end
local blockImpactSound = ReplicatedStorage:WaitForChild(GameConfig.Assets.BLOCK_IMPACT_SOUND)
if not blockImpactSound or not blockImpactSound:IsA("Sound") then return end
local bloodEffect = ReplicatedStorage:WaitForChild(GameConfig.Assets.BLOOD_EFFECT)
if not bloodEffect or not bloodEffect:IsA("Attachment") then return end
local combatEvent = Instance.new("RemoteEvent")
combatEvent.Name = "CombatEvent"
combatEvent.Parent = ReplicatedStorage
local cooldowns: {[Player]: number} = {}
local runRequested: {[Player]: boolean} = {}
local attackFreezeUntil: {[Player]: number} = {}
local function applyWalkSpeed(player: Player, humanoid: Humanoid): ()
	if humanoid.Health <= 0 then return end
	local target: number
	if os.clock() < (attackFreezeUntil[player] or 0) then
		target = GameConfig.Speed.ATTACK
	elseif humanoid:GetAttribute("Blocking") == true then
		target = GameConfig.Speed.BLOCK
	elseif runRequested[player] then
		target = GameConfig.Speed.RUN
	else
		target = GameConfig.Speed.WALK
	end
	humanoid.WalkSpeed = target + 1
	humanoid.WalkSpeed = target
end
local function isBlockingNow(enemyChar: Model, eHum: Humanoid): boolean
	if eHum:GetAttribute("Blocking") ~= true then return false end
	local enemyPlayer = Players:GetPlayerFromCharacter(enemyChar)
	if enemyPlayer and os.clock() < (attackFreezeUntil[enemyPlayer] or 0) then
		return false
	end
	return true
end
local function isAttackFromBehind(attackerPos: Vector3, enemyRoot: BasePart): boolean
	local flatOffset = Vector3.new(attackerPos.X - enemyRoot.Position.X, 0, attackerPos.Z - enemyRoot.Position.Z)
	if flatOffset.Magnitude == 0 then return false end
	local dot = enemyRoot.CFrame.LookVector:Dot(flatOffset.Unit)
	return dot < GameConfig.Combat.BACKSTAB_DOT_THRESHOLD
end
local function breakBlock(enemyChar: Model, eHum: Humanoid): ()
	if eHum:GetAttribute("Blocking") ~= true then return end
	eHum:SetAttribute("Blocking", false)
	local enemyPlayer = Players:GetPlayerFromCharacter(enemyChar)
	if enemyPlayer then
		applyWalkSpeed(enemyPlayer, eHum)
		combatEvent:FireClient(enemyPlayer, "BlockBroken")
	end
end
local function playComboVFX(rootPart: BasePart, isM1: boolean): ()
	local template = if isM1 then slashM1 else slashM2
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
local function playImpactHighlight(enemyChar: Model, fillColor: Color3): ()
	local highlight = Instance.new("Highlight")
	highlight.FillColor = fillColor
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
local function playImpactSound(enemyRoot: BasePart, template: Sound): ()
	local sound = template:Clone()
	sound.PlaybackSpeed = GameConfig.Combat.HIT_SOUND_MIN_PITCH + math.random() * (GameConfig.Combat.HIT_SOUND_MAX_PITCH - GameConfig.Combat.HIT_SOUND_MIN_PITCH)
	sound.Parent = enemyRoot
	sound:Play()
	task.delay(GameConfig.Combat.HIT_SOUND_LIFETIME, function(): ()
		if sound then sound:Destroy() end
	end)
end
local function playHitVFX(enemyChar: Model): ()
	playImpactHighlight(enemyChar, Color3.fromRGB(255, 0, 0))
	local enemyRoot = enemyChar:FindFirstChild("HumanoidRootPart")
	if not enemyRoot or not enemyRoot:IsA("BasePart") then return end
	playImpactSound(enemyRoot, hitImpactSound)
	local blood = bloodEffect:Clone()
	blood.Parent = enemyRoot
	local bloodEmitters: {ParticleEmitter} = {}
	for _, obj in ipairs(blood:GetDescendants()) do
		if obj:IsA("ParticleEmitter") then
			table.insert(bloodEmitters, obj)
			obj.Enabled = true
		end
	end
	task.delay(GameConfig.Combat.BLOOD_EMIT_DURATION, function(): ()
		for _, emitter in ipairs(bloodEmitters) do
			emitter.Enabled = false
		end
	end)
	task.delay(GameConfig.Combat.BLOOD_LIFETIME, function(): ()
		if blood then blood:Destroy() end
	end)
end
local function playBlockVFX(enemyChar: Model): ()
	playImpactHighlight(enemyChar, Color3.fromRGB(140, 190, 255))
	local enemyRoot = enemyChar:FindFirstChild("HumanoidRootPart")
	if not enemyRoot or not enemyRoot:IsA("BasePart") then return end
	playImpactSound(enemyRoot, blockImpactSound)
end
local function applyKnockback(attackerRoot: BasePart, enemyRoot: BasePart, force: number): ()
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
local function createHitbox(attackerChar: Model, attackerRoot: BasePart, runBonus: boolean): ()
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
	local function tryHit(hit: BasePart): ()
		if not hit or not hit.Parent then return end
		local enemyChar = hit.Parent
		if not enemyChar:IsA("Model") or enemyChar == attackerChar then return end
		local eHum = enemyChar:FindFirstChildOfClass("Humanoid")
		if not eHum then return end
		local eRoot = enemyChar:FindFirstChild("HumanoidRootPart")
		if not eRoot or not eRoot:IsA("BasePart") then return end
		if eHum.Health <= 0 or hitList[eHum] then return end
		hitList[eHum] = true
		if isBlockingNow(enemyChar, eHum) and not isAttackFromBehind(attackerRoot.Position, eRoot) then
			playBlockVFX(enemyChar)
			return
		end
		local dmg: number = if runBonus then GameConfig.Combat.DAMAGE * GameConfig.Combat.RUN_DAMAGE_MULT else GameConfig.Combat.DAMAGE
		local kb: number = if runBonus then GameConfig.Combat.KNOCKBACK * GameConfig.Combat.RUN_KNOCKBACK_MULT else GameConfig.Combat.KNOCKBACK
		if eHum:GetAttribute("Immortal") then
			eHum.Health = math.max(eHum.Health - dmg, 1)
		else
			eHum:TakeDamage(dmg)
		end
		playHitVFX(enemyChar)
		applyKnockback(attackerRoot, eRoot, kb)
		breakBlock(enemyChar, eHum)
	end
	local conn: RBXScriptConnection = hitbox.Touched:Connect(tryHit)
	for _, part: BasePart in ipairs(workspace:GetPartsInPart(hitbox)) do
		tryHit(part)
	end
	task.delay(GameConfig.Combat.HITBOX_ACTIVE, function(): ()
		if conn and conn.Connected then conn:Disconnect() end
		if hitbox then hitbox:Destroy() end
	end)
end
local function onCharacterAdded(player: Player, character: Model): ()
	local humanoid = character:WaitForChild("Humanoid", 5)
	if not humanoid or not humanoid:IsA("Humanoid") then return end
	runRequested[player] = false
	attackFreezeUntil[player] = 0
	applyWalkSpeed(player, humanoid)
end
local function onPlayerAdded(player: Player): ()
	if player.Character then
		onCharacterAdded(player, player.Character)
	end
	player.CharacterAdded:Connect(function(character: Model): ()
		onCharacterAdded(player, character)
	end)
end
for _, player: Player in ipairs(Players:GetPlayers()) do
	onPlayerAdded(player)
end
Players.PlayerAdded:Connect(onPlayerAdded)
Players.PlayerRemoving:Connect(function(player: Player): ()
	cooldowns[player] = nil
	runRequested[player] = nil
	attackFreezeUntil[player] = nil
end)
local function setupAttackingDummy(model: Model): ()
	local humanoid = model:WaitForChild("Humanoid", 5)
	if not humanoid or not humanoid:IsA("Humanoid") then return end
	local animator = humanoid:WaitForChild("Animator", 5)
	if not animator or not animator:IsA("Animator") then return end
	local rootPart = model:WaitForChild("HumanoidRootPart", 5)
	if not rootPart or not rootPart:IsA("BasePart") then return end
	local animController = AnimationController.new(animator, GameConfig.Animations)
	local comboToggle = false
	task.spawn(function(): ()
		while model.Parent and humanoid.Health > 0 do
			local trackName: string = if comboToggle then "m2" else "m1"
			local isM1: boolean = not comboToggle
			comboToggle = not comboToggle
			if animController:GetTrack(trackName) then
				animController:PlayTrack(trackName, 0.1)
				task.delay(GameConfig.Combat.VFX_DELAY, function(): ()
					if not rootPart.Parent or humanoid.Health <= 0 then return end
					playComboVFX(rootPart, isM1)
					createHitbox(model, rootPart, false)
				end)
			end
			task.wait(GameConfig.Combat.ATTACK_FREEZE_DURATION)
		end
		animController:Destroy()
	end)
end
local function setupBlockingDummy(model: Model): ()
	local humanoid = model:WaitForChild("Humanoid", 5)
	if not humanoid or not humanoid:IsA("Humanoid") then return end
	local animator = humanoid:WaitForChild("Animator", 5)
	if not animator or not animator:IsA("Animator") then return end
	local animController = AnimationController.new(animator, GameConfig.Animations)
	local function engageBlock(): ()
		if not model.Parent or humanoid.Health <= 0 then return end
		humanoid:SetAttribute("Blocking", true)
		animController:PlayTrack("block", 0.1)
	end
	local attributeConn: RBXScriptConnection = humanoid:GetAttributeChangedSignal("Blocking"):Connect(function(): ()
		if humanoid.Health <= 0 then return end
		if humanoid:GetAttribute("Blocking") ~= true then
			task.delay(GameConfig.Combat.BLOCK_REENGAGE_DELAY, engageBlock)
		end
	end)
	engageBlock()
	humanoid.Died:Once(function(): ()
		attributeConn:Disconnect()
		animController:Destroy()
	end)
end
local attackingDummy = workspace:FindFirstChild(GameConfig.Assets.ATTACKING_DUMMY)
if attackingDummy and attackingDummy:IsA("Model") then
	setupAttackingDummy(attackingDummy)
end
local blockingDummy = workspace:FindFirstChild(GameConfig.Assets.BLOCKING_DUMMY)
if blockingDummy and blockingDummy:IsA("Model") then
	setupBlockingDummy(blockingDummy)
end
combatEvent.OnServerEvent:Connect(function(player: Player, action: unknown): ()
	if typeof(action) ~= "string" then return end
	local character = player.Character
	if not character or not character:IsA("Model") then return end
	local humanoid = character:FindFirstChildOfClass("Humanoid")
	if not humanoid then return end
	if action == "RunStart" then
		runRequested[player] = true
		applyWalkSpeed(player, humanoid)
		return
	elseif action == "RunEnd" then
		runRequested[player] = false
		applyWalkSpeed(player, humanoid)
		return
	elseif action == "BlockStart" then
		humanoid:SetAttribute("Blocking", true)
		applyWalkSpeed(player, humanoid)
		return
	elseif action == "BlockEnd" then
		humanoid:SetAttribute("Blocking", false)
		applyWalkSpeed(player, humanoid)
		return
	end
	if action ~= "M1" and action ~= "M2" then return end
	if humanoid:GetAttribute("Blocking") == true then return end
	local now: number = os.clock()
	local last: number = cooldowns[player] or 0
	if now - last < GameConfig.Combat.COOLDOWN then return end
	local rootPart = character:FindFirstChild("HumanoidRootPart")
	if not rootPart or not rootPart:IsA("BasePart") then return end
	if humanoid.Health <= 0 then return end
	cooldowns[player] = now
	local isM1: boolean = (action == "M1")
	local runBonus: boolean = runRequested[player] == true
	attackFreezeUntil[player] = now + GameConfig.Combat.ATTACK_FREEZE_DURATION
	applyWalkSpeed(player, humanoid)
	task.delay(GameConfig.Combat.ATTACK_FREEZE_DURATION, function(): ()
		if os.clock() < (attackFreezeUntil[player] or 0) then return end
		local char2 = player.Character
		if not char2 then return end
		local hum2 = char2:FindFirstChildOfClass("Humanoid")
		if hum2 then applyWalkSpeed(player, hum2) end
	end)
	task.delay(GameConfig.Combat.VFX_DELAY, function(): ()
		if not character.Parent or not rootPart.Parent or humanoid.Health <= 0 then return end
		playComboVFX(rootPart, isM1)
		createHitbox(character, rootPart, runBonus)
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
local rootPart = character:WaitForChild("HumanoidRootPart")
if not rootPart or not rootPart:IsA("BasePart") then return end
local footstepSound = rootPart:WaitForChild(GameConfig.Assets.FOOTSTEP_SOUND)
if not footstepSound or not footstepSound:IsA("Sound") then return end
footstepSound.Looped = false
local combatEvent = ReplicatedStorage:WaitForChild("CombatEvent")
if not combatEvent or not combatEvent:IsA("RemoteEvent") then return end
humanoid:SetStateEnabled(Enum.HumanoidStateType.Jumping, false)
local AIRBORNE_STATES: {[Enum.HumanoidStateType]: boolean} = {
	[Enum.HumanoidStateType.Freefall] = true,
	[Enum.HumanoidStateType.Jumping] = true,
	[Enum.HumanoidStateType.FallingDown] = true,
	[Enum.HumanoidStateType.Ragdoll] = true,
}
local maid = Maid.new()
local attackMaid = Maid.new()
local animController = AnimationController.new(animator, GameConfig.Animations)
local running: boolean = false
local attacking: boolean = false
local airborne: boolean = false
local blocking: boolean = false
local footstepMoving: boolean = false
local isDestroyed: boolean = false
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
	local target: string
	if blocking then
		target = "block"
	elseif humanoid.MoveDirection.Magnitude > 0 then
		target = if running then "run" else "walk"
	else
		target = "idle"
	end
	if animController:GetCurrentName() ~= target then
		animController:PlayTrack(target, blendTime or 0.2)
	end
end
local function refreshFootsteps(): ()
	if isDestroyed then return end
	local currentName = animController:GetCurrentName()
	if currentName == "walk" or currentName == "run" then
		local moveTrack = animController:GetTrack(currentName)
		if moveTrack and moveTrack.Length > 0 and footstepSound.TimeLength > 0 then
			footstepSound.PlaybackSpeed = footstepSound.TimeLength / (moveTrack.Length / 2)
		end
	end
	local shouldMove = humanoid.Health > 0 and humanoid.WalkSpeed > 0 and humanoid.MoveDirection.Magnitude > 0 and not AIRBORNE_STATES[humanoid:GetState()]
	if shouldMove and not footstepMoving then
		footstepMoving = true
		if not footstepSound.IsPlaying then
			footstepSound:Play()
		end
	elseif not shouldMove then
		footstepMoving = false
	end
end
maid:GiveTask(footstepSound.Ended:Connect(function(): ()
	if footstepMoving then
		footstepSound:Play()
	end
end))
local comboToggle: boolean = false
local lastComboTime: number = 0
local function executeAttack(): ()
	if attacking or isDestroyed or humanoid.Health <= 0 or airborne or blocking then return end
	if os.clock() - lastComboTime > GameConfig.Combat.COMBO_RESET_WINDOW then
		comboToggle = false
	end
	local actionName: string = if comboToggle then "M2" else "M1"
	local trackName: string = string.lower(actionName)
	local track = animController:GetTrack(trackName)
	if not track then return end
	attacking = true
	animController:PlayTrack(trackName, 0.1)
	combatEvent:FireServer(actionName)
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
			updateState(0.1)
		end
	end))
end
maid:GiveTask(humanoid:GetPropertyChangedSignal("MoveDirection"):Connect(function(): ()
	updateState()
	refreshFootsteps()
end))
maid:GiveTask(humanoid:GetPropertyChangedSignal("WalkSpeed"):Connect(refreshFootsteps))
maid:GiveTask(humanoid.StateChanged:Connect(function(_: Enum.HumanoidStateType, newState: Enum.HumanoidStateType): ()
	airborne = AIRBORNE_STATES[newState] == true
	if airborne then
		animController:StopCurrent(0.2)
	else
		updateState(0.1)
	end
	refreshFootsteps()
end))
maid:GiveTask(combatEvent.OnClientEvent:Connect(function(message: unknown): ()
	if message == "BlockBroken" and blocking then
		blocking = false
		updateState(0.1)
	end
end))
maid:GiveTask(UserInputService.InputBegan:Connect(function(input: InputObject, gp: boolean): ()
	if gp or humanoid.Health <= 0 or isDestroyed then return end
	if input.KeyCode == Enum.KeyCode.LeftShift then
		running = true
		combatEvent:FireServer("RunStart")
		updateState()
	elseif input.KeyCode == Enum.KeyCode.F then
		blocking = true
		combatEvent:FireServer("BlockStart")
		updateState()
	elseif input.UserInputType == Enum.UserInputType.MouseButton1 then
		executeAttack()
	end
end))
maid:GiveTask(UserInputService.InputEnded:Connect(function(input: InputObject): ()
	if isDestroyed then return end
	if input.KeyCode == Enum.KeyCode.LeftShift then
		running = false
		combatEvent:FireServer("RunEnd")
		updateState()
	elseif input.KeyCode == Enum.KeyCode.F then
		blocking = false
		combatEvent:FireServer("BlockEnd")
		updateState()
	end
end))
task.spawn(function(): ()
	while not isDestroyed do
		refreshFootsteps()
		task.wait(0.2)
	end
end)
local function destroy(): ()
	if isDestroyed then return end
	isDestroyed = true
	comboToggle = false
	footstepMoving = false
	blocking = false
	attackMaid:DoCleaning()
	maid:DoCleaning()
	animController:Destroy()
end
maid:GiveTask(humanoid.Died:Connect(destroy))
maid:GiveTask(character.Destroying:Connect(destroy))`,

        'AnimationController.lua': `--!strict
local AnimationController = {}
AnimationController.__index = AnimationController
type TrackMap = {[string]: AnimationTrack}
export type AnimationController = typeof(setmetatable({} :: { _tracks: TrackMap, _current: string }, AnimationController))
local PRIORITIES: {[string]: Enum.AnimationPriority} = {idle = Enum.AnimationPriority.Idle, walk = Enum.AnimationPriority.Movement, run = Enum.AnimationPriority.Movement, m1 = Enum.AnimationPriority.Action, m2 = Enum.AnimationPriority.Action, block = Enum.AnimationPriority.Idle}
local LOOPED: {[string]: boolean} = {idle = true, walk = true, run = true, m1 = false, m2 = false, block = true}
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

        'Sound.lua': `--!strict`,

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
export type CombatConfig = {
	DAMAGE: number,
	KNOCKBACK: number,
	MAX_KNOCKBACK_FORCE: number,
	COOLDOWN: number,
	VFX_DELAY: number,
	VFX_EMIT_DURATION: number,
	VFX_LIFETIME: number,
	HITBOX_ACTIVE: number,
	KNOCKBACK_DURATION: number,
	HIGHLIGHT_DURATION: number,
	RUN_DAMAGE_MULT: number,
	RUN_KNOCKBACK_MULT: number,
	COMBO_RESET_WINDOW: number,
	HIT_SOUND_LIFETIME: number,
	HIT_SOUND_MIN_PITCH: number,
	HIT_SOUND_MAX_PITCH: number,
	BLOOD_EMIT_DURATION: number,
	BLOOD_LIFETIME: number,
	ATTACK_FREEZE_DURATION: number,
	BACKSTAB_DOT_THRESHOLD: number,
	BLOCK_REENGAGE_DELAY: number,
}
export type SpeedConfig = {WALK: number, RUN: number, ATTACK: number, BLOCK: number}
export type AnimationIds = {IDLE: string, WALK: string, RUN: string, M1: string, M2: string, BLOCK: string}
export type AssetNames = {
	FOOTSTEP_SOUND: string,
	HIT_IMPACT_SOUND: string,
	SLASH_EFFECT_M1: string,
	SLASH_EFFECT_M2: string,
	BLOOD_EFFECT: string,
	HITBOX: string,
	ATTACKING_DUMMY: string,
	BLOCK_IMPACT_SOUND: string,
	BLOCKING_DUMMY: string,
}

local GameConfig = {}
GameConfig.Combat = table.freeze({
	DAMAGE = 25,
	KNOCKBACK = 40,
	MAX_KNOCKBACK_FORCE = 120,
	COOLDOWN = 0.4,
	VFX_DELAY = 0.25,
	VFX_EMIT_DURATION = 0.3,
	VFX_LIFETIME = 1,
	HITBOX_ACTIVE = 0.35,
	KNOCKBACK_DURATION = 0.15,
	HIGHLIGHT_DURATION = 0.3,
	RUN_DAMAGE_MULT = 1.2,
	RUN_KNOCKBACK_MULT = 1.35,
	COMBO_RESET_WINDOW = 1,
	HIT_SOUND_LIFETIME = 1,
	HIT_SOUND_MIN_PITCH = 0.95,
	HIT_SOUND_MAX_PITCH = 1.05,
	BLOOD_EMIT_DURATION = 0.5,
	BLOOD_LIFETIME = 1.5,
	ATTACK_FREEZE_DURATION = 1.25,
	BACKSTAB_DOT_THRESHOLD = 0,
	BLOCK_REENGAGE_DELAY = 1,
}) :: CombatConfig
GameConfig.Speed = table.freeze({WALK = 12, RUN = 20, ATTACK = 0, BLOCK = 0}) :: SpeedConfig
GameConfig.Animations = table.freeze({IDLE = "rbxassetid://100543849291511", WALK = "rbxassetid://108096244047063", RUN = "rbxassetid://91574816420777", M1 = "rbxassetid://98255810475707", M2 = "rbxassetid://119644330061039", BLOCK = "rbxassetid://137151920548099"}) :: AnimationIds
GameConfig.Assets = table.freeze({
	FOOTSTEP_SOUND = "FootstepSound",
	HIT_IMPACT_SOUND = "HitImpactSound",
	SLASH_EFFECT_M1 = "SlashEffectM1",
	SLASH_EFFECT_M2 = "SlashEffectM2",
	BLOOD_EFFECT = "BloodEffect",
	HITBOX = "Hitbox",
	ATTACKING_DUMMY = "AttackingDummy",
	BLOCK_IMPACT_SOUND = "BlockImpactSound",
	BLOCKING_DUMMY = "BlockingDummy",
}) :: AssetNames
return table.freeze(GameConfig)`,

        'Animate.lua': `--!strict`,

        'readme.md': `# 📁 Project Structure
\`\`\`
ReplicatedStorage/
├── AnimationGraphEditor/
├── Shared/
│   ├── AnimationController       ← ModuleScript
│   ├── GameConfig                ← ModuleScript
│   └── Maid                      ← ModuleScript
├── CombatEvent                   ← RemoteEvent 
├── Hitbox                        ← Part
├── HitImpactSound                ← Sound
├── BlockImpactSound              ← Sound
├── SlashEffectM1                 ← Attachment
├── SlashEffectM2                 ← Attachment
└── BloodEffect                   ← Attachment

ServerScriptService/
└── CombatHandler                 ← Script 

StarterPlayer/
├── StarterCharacter/
│   ├── HumanoidRootPart
│   │   └── FootstepSound         ← Sound
│   └── AnimSaves/                ← ObjectValue 
├── StarterCharacterScripts/
│   ├── Animate                   ← LocalScript 
│   ├── Sound                     ← LocalScript 
│   └── CombatController          ← LocalScript
└── StarterPlayerScripts/
    └── RbxCharacterSounds        ← LocalScript 

Workspace/
├── TrainingDummy/                ← Model  
│   └── DummyIdle                 ← Script 
├── AttackingDummy/                ← Model  
└── BlockingDummy/                 ← Model 
\`\`\``
      }
    },

    ragdoll: {
      name: 'R6 & R15 Ragdoll system',
      files: {
        'RagdollServer.lua': `--!strict

local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")

local RagdollFolder = ReplicatedStorage:WaitForChild("Ragdoll")
local GameConfig = require(RagdollFolder:WaitForChild("GameConfig"))
local Maid = require(RagdollFolder:WaitForChild("Maid"))
local RagdollController = require(script.Parent.RagdollController)

local toggleRequestRemote = RagdollFolder:WaitForChild(GameConfig.RagdollRemoteName) :: RemoteEvent

local lastToggleTime: { [Player]: number } = {}
local playerMaids: { [Player]: Maid.Maid } = {}

local function onCharacterAdded(player: Player, character: Model): ()
	local humanoid = character:WaitForChild("Humanoid", 10)
	if not humanoid or not humanoid:IsA("Humanoid") then
		return
	end

	humanoid.BreakJointsOnDeath = false
	humanoid:SetAttribute(GameConfig.RagdollAttribute, false)

	local maid = playerMaids[player]
	if not maid then
		return
	end
	maid:DoCleaning()

	maid:GiveTask(humanoid.Died:Once(function()
		RagdollController.Engage(character, humanoid, true)
	end))
end

local function onCharacterRemoving(character: Model): ()
	RagdollController.Cleanup(character)
end

local function onPlayerAdded(player: Player): ()
	lastToggleTime[player] = 0
	playerMaids[player] = Maid.new()

	player.CharacterAdded:Connect(function(character)
		onCharacterAdded(player, character)
	end)

	player.CharacterRemoving:Connect(onCharacterRemoving)

	local character = player.Character
	if character then
		onCharacterAdded(player, character)
	end
end

local function onPlayerRemoving(player: Player): ()
	lastToggleTime[player] = nil

	local maid = playerMaids[player]
	if maid then
		maid:Destroy()
		playerMaids[player] = nil
	end
end

toggleRequestRemote.OnServerEvent:Connect(function(player: Player)
	local now = os.clock()
	local last = lastToggleTime[player] or 0
	if now - last < GameConfig.ToggleCooldownSeconds then
		return
	end
	lastToggleTime[player] = now

	local character = player.Character
	if not character then
		return
	end

	local humanoid = character:FindFirstChildOfClass("Humanoid")
	if not humanoid or humanoid.Health <= 0 then
		return
	end

	if RagdollController.IsActive(character) then
		RagdollController.Release(character, humanoid)
	else
		RagdollController.Engage(character, humanoid, false)
	end
end)

Players.PlayerAdded:Connect(onPlayerAdded)
Players.PlayerRemoving:Connect(onPlayerRemoving)

for _, existingPlayer in ipairs(Players:GetPlayers()) do
	onPlayerAdded(existingPlayer)
end`,

        'RagdollController.lua': `--!strict

local PhysicsService = game:GetService("PhysicsService")
local ReplicatedStorage = game:GetService("ReplicatedStorage")

local RagdollFolder = ReplicatedStorage:WaitForChild("Ragdoll")
local GameConfig = require(RagdollFolder:WaitForChild("GameConfig"))
local Maid = require(RagdollFolder:WaitForChild("Maid"))

local HUMANOID_STATE_TYPES: { Enum.HumanoidStateType } = {}
for _, stateType in ipairs(Enum.HumanoidStateType:GetEnumItems()) do
	if stateType ~= Enum.HumanoidStateType.None then
		table.insert(HUMANOID_STATE_TYPES, stateType)
	end
end

type PartRecord = {
	part: BasePart,
	canCollide: boolean,
	collisionGroup: string,
}

type RagdollState = {
	jointsMaid: Maid.Maid,
	parts: { PartRecord },
	permanent: boolean,
	previousAutoRotate: boolean,
	previousWalkSpeed: number,
	previousJumpPower: number,
	previousStateEnabled: { [Enum.HumanoidStateType]: boolean },
}

local activeStates: { [Model]: RagdollState } = {}

local RagdollController = {}

local function ensureCollisionGroup(): ()
	if not PhysicsService:IsCollisionGroupRegistered(GameConfig.CollisionGroupName) then
		PhysicsService:RegisterCollisionGroup(GameConfig.CollisionGroupName)
	end
	PhysicsService:CollisionGroupSetCollidable(GameConfig.CollisionGroupName, GameConfig.CollisionGroupName, false)
end

ensureCollisionGroup()

local function engageJoint(descendant: Instance, jointsMaid: Maid.Maid): ()
	if descendant:IsA("AnimationConstraint") then
		local previousLinearStrength = descendant.LinearStrength
		local previousAngularStrength = descendant.AngularStrength
		descendant.LinearStrength = 0
		descendant.AngularStrength = 0
		descendant.IsKinematic = false
		jointsMaid:GiveTask(function()
			descendant.LinearStrength = previousLinearStrength
			descendant.AngularStrength = previousAngularStrength
			descendant.IsKinematic = true
		end)
	elseif descendant:IsA("Motor6D") and descendant.Enabled then
		local part0 = descendant.Part0
		local part1 = descendant.Part1
		if not part0 or not part1 then
			return
		end

		local attachment0 = Instance.new("Attachment")
		attachment0.Name = "Ragdoll_" .. descendant.Name .. "_A0"
		attachment0.CFrame = descendant.C0
		attachment0.Parent = part0

		local attachment1 = Instance.new("Attachment")
		attachment1.Name = "Ragdoll_" .. descendant.Name .. "_A1"
		attachment1.CFrame = descendant.C1
		attachment1.Parent = part1

		local socket = Instance.new("BallSocketConstraint")
		socket.Name = "Ragdoll_" .. descendant.Name .. "_Socket"
		socket.Attachment0 = attachment0
		socket.Attachment1 = attachment1
		socket.LimitsEnabled = false
		socket.Parent = part0

		descendant.Enabled = false

		jointsMaid:GiveTask(attachment0)
		jointsMaid:GiveTask(attachment1)
		jointsMaid:GiveTask(socket)
		jointsMaid:GiveTask(function()
			descendant.Enabled = true
		end)
	end
end

function RagdollController.Engage(character: Model, humanoid: Humanoid, permanent: boolean): boolean
	local existing = activeStates[character]
	if existing then
		if permanent then
			existing.permanent = true
		end
		return true
	end

	if not humanoid.RootPart then
		return false
	end

	local state: RagdollState = {
		jointsMaid = Maid.new(),
		parts = {},
		permanent = permanent,
		previousAutoRotate = humanoid.AutoRotate,
		previousWalkSpeed = humanoid.WalkSpeed,
		previousJumpPower = humanoid.JumpPower,
		previousStateEnabled = {},
	}

	for _, descendant in ipairs(character:GetDescendants()) do
		if descendant:IsA("BasePart") then
			local part: BasePart = descendant
			table.insert(state.parts, {
				part = part,
				canCollide = part.CanCollide,
				collisionGroup = part.CollisionGroup,
			})
			if part.Name ~= GameConfig.RootPartName then
				part.CanCollide = true
			end
			part.CollisionGroup = GameConfig.CollisionGroupName
			pcall(function()
				part:SetNetworkOwner(nil)
			end)
		else
			engageJoint(descendant, state.jointsMaid)
		end
	end

	for _, stateType in ipairs(HUMANOID_STATE_TYPES) do
		state.previousStateEnabled[stateType] = humanoid:GetStateEnabled(stateType)
		if stateType ~= Enum.HumanoidStateType.Physics and stateType ~= Enum.HumanoidStateType.Dead then
			humanoid:SetStateEnabled(stateType, false)
		end
	end

	humanoid.AutoRotate = false
	humanoid.WalkSpeed = 0
	humanoid.JumpPower = 0
	if humanoid:GetState() ~= Enum.HumanoidStateType.Dead then
		humanoid:ChangeState(Enum.HumanoidStateType.Physics)
	end
	humanoid:SetAttribute(GameConfig.RagdollAttribute, true)

	activeStates[character] = state

	return true
end

function RagdollController.Release(character: Model, humanoid: Humanoid): boolean
	local state = activeStates[character]
	if not state or state.permanent then
		return false
	end

	state.jointsMaid:Destroy()

	for stateType, wasEnabled in pairs(state.previousStateEnabled) do
		humanoid:SetStateEnabled(stateType, wasEnabled)
	end

	humanoid.AutoRotate = state.previousAutoRotate
	humanoid.WalkSpeed = state.previousWalkSpeed
	humanoid.JumpPower = state.previousJumpPower
	humanoid:SetAttribute(GameConfig.RagdollAttribute, false)
	humanoid:ChangeState(Enum.HumanoidStateType.GettingUp)

	for _, record in ipairs(state.parts) do
		record.part.CanCollide = record.canCollide
		record.part.CollisionGroup = record.collisionGroup
		pcall(function()
			record.part:SetNetworkOwnershipAuto()
		end)
	end

	activeStates[character] = nil

	return true
end

function RagdollController.IsActive(character: Model): boolean
	return activeStates[character] ~= nil
end

function RagdollController.IsPermanent(character: Model): boolean
	local state = activeStates[character]
	return state ~= nil and state.permanent
end

function RagdollController.Cleanup(character: Model): ()
	local state = activeStates[character]
	if state then
		state.jointsMaid:Destroy()
	end
	activeStates[character] = nil
end

return RagdollController`,

        'RagdollInput.lua': `--!strict

local ContextActionService = game:GetService("ContextActionService")
local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")

local RagdollFolder = ReplicatedStorage:WaitForChild("Ragdoll")
local GameConfig = require(RagdollFolder:WaitForChild("GameConfig"))
local Maid = require(RagdollFolder:WaitForChild("Maid"))

local ALL_HUMANOID_STATES: { Enum.HumanoidStateType } = {}
for _, stateType in ipairs(Enum.HumanoidStateType:GetEnumItems()) do
	if stateType ~= Enum.HumanoidStateType.None then
		table.insert(ALL_HUMANOID_STATES, stateType)
	end
end

local player = Players.LocalPlayer :: Player

local toggleRequestRemote = RagdollFolder:WaitForChild(GameConfig.RagdollRemoteName) :: RemoteEvent

local characterMaid = Maid.new()

local function applyLocalRagdollVisuals(humanoid: Humanoid, ragdolled: boolean): ()
	if ragdolled then
		for _, stateType in ipairs(ALL_HUMANOID_STATES) do
			if stateType ~= Enum.HumanoidStateType.Physics and stateType ~= Enum.HumanoidStateType.Dead then
				humanoid:SetStateEnabled(stateType, false)
			end
		end
		humanoid.AutoRotate = false
		local currentState = humanoid:GetState()
		if currentState ~= Enum.HumanoidStateType.Physics and currentState ~= Enum.HumanoidStateType.Dead then
			humanoid:ChangeState(Enum.HumanoidStateType.Physics)
		end
	else
		for _, stateType in ipairs(ALL_HUMANOID_STATES) do
			humanoid:SetStateEnabled(stateType, true)
		end
		humanoid.AutoRotate = true
		if humanoid:GetState() == Enum.HumanoidStateType.Physics then
			humanoid:ChangeState(Enum.HumanoidStateType.GettingUp)
		end
	end
end

local function applyCameraSubject(character: Model, humanoid: Humanoid, ragdolled: boolean): ()
	local currentCamera = workspace.CurrentCamera
	if not currentCamera then
		return
	end
	if ragdolled then
		local cameraPart = character:FindFirstChild(GameConfig.CameraSubjectPartName)
		if cameraPart and cameraPart:IsA("BasePart") then
			currentCamera.CameraSubject = cameraPart
		end
	else
		currentCamera.CameraSubject = humanoid
	end
end

local function onCharacterAdded(character: Model): ()
	characterMaid:DoCleaning()

	local humanoid = character:WaitForChild("Humanoid", 10)
	if not humanoid or not humanoid:IsA("Humanoid") then
		return
	end

	local ragdolled = humanoid:GetAttribute(GameConfig.RagdollAttribute) == true
	applyLocalRagdollVisuals(humanoid, ragdolled)
	applyCameraSubject(character, humanoid, ragdolled)

	characterMaid:GiveTask(humanoid:GetAttributeChangedSignal(GameConfig.RagdollAttribute):Connect(function()
		local isRagdolled = humanoid:GetAttribute(GameConfig.RagdollAttribute) == true
		applyLocalRagdollVisuals(humanoid, isRagdolled)
		applyCameraSubject(character, humanoid, isRagdolled)
	end))
end

local function handleToggleAction(
	_actionName: string,
	inputState: Enum.UserInputState,
	_inputObject: InputObject
): Enum.ContextActionResult
	if inputState == Enum.UserInputState.Begin then
		toggleRequestRemote:FireServer()
	end
	return Enum.ContextActionResult.Sink
end

ContextActionService:BindAction(GameConfig.ToggleActionName, handleToggleAction, true, GameConfig.ToggleKeyCode)
ContextActionService:SetTitle(GameConfig.ToggleActionName, "Ragdoll")

player.CharacterAdded:Connect(onCharacterAdded)

local currentCharacter = player.Character
if currentCharacter then
	onCharacterAdded(currentCharacter)
end`,

        'Maid.lua': `--!strict

export type Task = RBXScriptConnection | Instance | thread | (() -> ()) | { Destroy: (unknown) -> () }

local Maid = {}
Maid.__index = Maid

export type Maid = typeof(setmetatable(
	{} :: {
		_items: { Task },
		_destroyed: boolean,
	},
	Maid
))

function Maid.new(): Maid
	return setmetatable({
		_items = {},
		_destroyed = false,
	}, Maid)
end

local function cleanupItem(item: Task): ()
	local itemType = typeof(item)
	if itemType == "RBXScriptConnection" then
		(item :: RBXScriptConnection):Disconnect()
	elseif itemType == "Instance" then
		(item :: Instance):Destroy()
	elseif itemType == "thread" then
		task.cancel(item :: thread)
	elseif itemType == "function" then
		(item :: () -> ())()
	elseif itemType == "table" then
		local destroyable = item :: { Destroy: ((unknown) -> ())? }
		if destroyable.Destroy then
			destroyable:Destroy()
		end
	end
end

function Maid.GiveTask(self: Maid, item: Task): Task
	if self._destroyed then
		cleanupItem(item)
		return item
	end
	table.insert(self._items, item)
	return item
end

function Maid.DoCleaning(self: Maid): ()
	local items = self._items
	self._items = {}
	for index = #items, 1, -1 do
		cleanupItem(items[index])
	end
end

function Maid.Destroy(self: Maid): ()
	self._destroyed = true
	self:DoCleaning()
end

return Maid`,

        'GameConfig.lua': `--!strict

local GameConfig = {
	CollisionGroupName = "RagdollCharacterParts",
	RagdollAttribute = "Ragdolled",
	RagdollRemoteName = "RagdollToggleRequest",
	ToggleActionName = "ToggleRagdoll",
	ToggleKeyCode = Enum.KeyCode.R,
	ToggleCooldownSeconds = 0.5,
	CameraSubjectPartName = "Head",
	RootPartName = "HumanoidRootPart",
}

table.freeze(GameConfig)

return GameConfig`,

        'readme.md': `# 📁 Project Structure
\`\`\`
ReplicatedStorage/
└ Ragdoll/
  ├ GameConfig            ← ModuleScript
  ├ Maid                  ← ModuleScript
  └ RagdollToggleRequest  ← RemoteEvent

ServerScriptService/
└ Ragdoll/
  ├ RagdollController     ← ModuleScript
  └ RagdollServer         ← Script

StarterPlayer/
└ StarterPlayerScripts/
  └ RagdollInput          ← LocalScript
\`\`\``
      }
    },

    tink: {
      name: 'Tink',
      files: {
        'Spark.lua': `--!strict

local RunService = game:GetService("RunService")
local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")

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

Spark.StageTimeoutSeconds = 30

local state: SparkState = "Idle"
local startPromise: any = nil
local clientServiceCache: { [string]: ClientServiceProxy } = {}

Spark.CreateService = ServiceModule.CreateService
Spark.CreateController = ControllerModule.CreateController
Spark.CreateRemoteSignal = ServiceModule.CreateRemoteSignal
Spark.CreateUnreliableRemoteSignal = ServiceModule.CreateUnreliableRemoteSignal
Spark.CreateRemoteProperty = ServiceModule.CreateRemoteProperty

local function safeRequire(module: ModuleScript): ()
	local ok: boolean, err: any = xpcall(require, debug.traceback, module)
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

local function runLifecycleStage(
	objects: { [string]: any },
	methodName: string,
	stageName: string,
	failed: { [any]: boolean }
): any
	return Promise.new(function(resolve: (...any) -> (), _reject: (...any) -> ())
		local toRun: { any } = {}
		for _, object in objects do
			if not failed[object] and type(object[methodName]) == "function" then
				table.insert(toRun, object)
			end
		end

		local total: number = #toRun
		if total == 0 then
			resolve()
			return
		end

		local remaining: number = total
		local function settleOne(): ()
			remaining -= 1
			if remaining <= 0 then
				resolve()
			end
		end

		for _, object in toRun do
			task.spawn(function()
				local objectName: string = tostring(object.Name)
				local ok: boolean, result: any = xpcall(object[methodName] :: (any) -> any, debug.traceback, object)

				if not ok then
					failed[object] = true
					warn("[Spark] " .. stageName .. " failed for '" .. objectName .. "': " .. tostring(result))
					settleOne()
					return
				end

				if Promise.is(result) then
					result:timeout(Spark.StageTimeoutSeconds, "[Spark] " .. stageName .. " timed out"):andThen(function()
						settleOne()
					end):catch(function(err: any)
						failed[object] = true
						warn("[Spark] " .. stageName .. " rejected for '" .. objectName .. "': " .. tostring(err))
						settleOne()
					end)
				else
					settleOne()
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
				task.spawn(function()
					local ok: boolean, err: any =
						xpcall(handler :: (any, Player) -> (), debug.traceback, service, player)
					if not ok then
						warn("[Spark] OnPlayerRemoving failed for '" .. tostring(service.Name) .. "': " .. tostring(err))
					end
				end)
			end
		end
	end)

	local failed: { [any]: boolean } = {}
	return runLifecycleStage(services, "OnInit", "OnInit", failed):andThen(function()
		return runLifecycleStage(services, "OnStart", "OnStart", failed)
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
	local proxy = setmetatable({ Name = serviceName }, {
		__index = function(_t: any, key: string): any
			error("[Spark] Service '" .. serviceName .. "' has no client member '" .. tostring(key) .. "'", 2)
		end,
	}) :: ClientServiceProxy

	local root = ReplicatedStorage:FindFirstChild("SparkRemotes")
	if root == nil or not root:IsA("Folder") then
		return proxy
	end

	local serviceFolder = root:FindFirstChild(serviceName)
	if serviceFolder == nil or not serviceFolder:IsA("Folder") then
		return proxy
	end

	local sf: Folder = serviceFolder :: Folder
	local pendingRPE: { [string]: RemoteEvent } = {}

	for _, child in sf:GetChildren() do
		local memberName, kind = Network.ParseLeafName(child.Name)
		if memberName == nil or kind == nil then
			continue
		end

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
		elseif (kind == "RE" or kind == "URE") and (child:IsA("RemoteEvent") or child:IsA("UnreliableRemoteEvent")) then
			local remoteEvent = child :: RemoteEvent
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
		local rpfKey: string = memberName .. "/RPF"
		local rfChild = sf:FindFirstChild(rpfKey)
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
	local failed: { [any]: boolean } = {}
	return Promise.new(function(resolve: (...any) -> (), _reject: (...any) -> ())
		Network.WaitForReady()
		resolve()
	end):andThen(function()
		local controllers = ControllerModule._getAll()
		return runLifecycleStage(controllers, "OnInit", "OnInit", failed)
	end):andThen(function()
		local controllers = ControllerModule._getAll()
		return runLifecycleStage(controllers, "OnStart", "OnStart", failed)
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

return Spark`,

        'Signal.lua': `--!strict

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

        'Network.lua': `--!strict

local RunService = game:GetService("RunService")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Players = game:GetService("Players")

local IS_SERVER: boolean = RunService:IsServer()
local FOLDER_NAME: string = "SparkRemotes"
local READY_MARKER: string = "__spark_ready__"

export type RemoteKind = "RE" | "RF" | "URE" | "RPE" | "RPF"

local Kind = {
	RemoteEvent = "RE" :: RemoteKind,
	RemoteFunction = "RF" :: RemoteKind,
	Unreliable = "URE" :: RemoteKind,
	PropertyEvent = "RPE" :: RemoteKind,
	PropertyFunction = "RPF" :: RemoteKind,
}

local cachedFolder: Folder? = nil
local serviceFolderCache: { [string]: Folder } = {}

local eventCache: { [string]: RemoteEvent } = {}
local functionCache: { [string]: RemoteFunction } = {}
local unreliableCache: { [string]: UnreliableRemoteEvent } = {}
local propEventCache: { [string]: RemoteEvent } = {}
local propFunctionCache: { [string]: RemoteFunction } = {}

local rateBuckets: { [Player]: { [string]: { count: number, windowStart: number } } } = {}

local Network = {}
Network.Kind = Kind
Network.RateLimitWindow = 1
Network.RateLimitMaxCalls = 40

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
Network.GetFolder = getFolder

local function getServiceFolder(serviceName: string): Folder
	local cached = serviceFolderCache[serviceName]
	if cached ~= nil then
		return cached
	end
	local root = getFolder()
	if IS_SERVER then
		local existing = root:FindFirstChild(serviceName)
		if existing ~= nil and existing:IsA("Folder") then
			serviceFolderCache[serviceName] = existing
			return existing
		end
		local created = Instance.new("Folder")
		created.Name = serviceName
		created.Parent = root
		serviceFolderCache[serviceName] = created
		return created
	end
	local found = root:WaitForChild(serviceName, 60)
	assert(found ~= nil and found:IsA("Folder"), "[Spark.Network] Service folder did not replicate in time: " .. serviceName)
	local folder = found :: Folder
	serviceFolderCache[serviceName] = folder
	return folder
end
Network.GetServiceFolder = getServiceFolder

local function leafName(member: string, kind: RemoteKind): string
	return member .. "/" .. kind
end

local function parseLeafName(name: string): (string?, RemoteKind?)
	local parts: { string } = string.split(name, "/")
	if #parts ~= 2 then
		return nil, nil
	end
	local kind = parts[2]
	if kind ~= "RE" and kind ~= "RF" and kind ~= "URE" and kind ~= "RPE" and kind ~= "RPF" then
		return nil, nil
	end
	return parts[1], kind :: RemoteKind
end
Network.ParseLeafName = parseLeafName

local function cacheKey(service: string, member: string, kind: RemoteKind): string
	return service .. "/" .. member .. "/" .. kind
end

local function getRemoteEvent(service: string, member: string): RemoteEvent
	local ck = cacheKey(service, member, Kind.RemoteEvent)
	local cached = eventCache[ck]
	if cached ~= nil then
		return cached
	end
	local folder = getServiceFolder(service)
	local key = leafName(member, Kind.RemoteEvent)
	if IS_SERVER then
		local existing = folder:FindFirstChild(key)
		if existing ~= nil and existing:IsA("RemoteEvent") then
			eventCache[ck] = existing
			return existing
		end
		local remote = Instance.new("RemoteEvent")
		remote.Name = key
		remote.Parent = folder
		eventCache[ck] = remote
		return remote
	end
	local found = folder:WaitForChild(key, 60)
	assert(found ~= nil and found:IsA("RemoteEvent"), "[Spark.Network] RemoteEvent not found: " .. ck)
	local remote = found :: RemoteEvent
	eventCache[ck] = remote
	return remote
end
Network.GetRemoteEvent = getRemoteEvent

local function getRemoteFunction(service: string, member: string): RemoteFunction
	local ck = cacheKey(service, member, Kind.RemoteFunction)
	local cached = functionCache[ck]
	if cached ~= nil then
		return cached
	end
	local folder = getServiceFolder(service)
	local key = leafName(member, Kind.RemoteFunction)
	if IS_SERVER then
		local existing = folder:FindFirstChild(key)
		if existing ~= nil and existing:IsA("RemoteFunction") then
			functionCache[ck] = existing
			return existing
		end
		local remote = Instance.new("RemoteFunction")
		remote.Name = key
		remote.Parent = folder
		functionCache[ck] = remote
		return remote
	end
	local found = folder:WaitForChild(key, 60)
	assert(found ~= nil and found:IsA("RemoteFunction"), "[Spark.Network] RemoteFunction not found: " .. ck)
	local remote = found :: RemoteFunction
	functionCache[ck] = remote
	return remote
end
Network.GetRemoteFunction = getRemoteFunction

local function getUnreliableRemoteEvent(service: string, member: string): UnreliableRemoteEvent
	local ck = cacheKey(service, member, Kind.Unreliable)
	local cached = unreliableCache[ck]
	if cached ~= nil then
		return cached
	end
	local folder = getServiceFolder(service)
	local key = leafName(member, Kind.Unreliable)
	if IS_SERVER then
		local existing = folder:FindFirstChild(key)
		if existing ~= nil and existing:IsA("UnreliableRemoteEvent") then
			unreliableCache[ck] = existing
			return existing
		end
		local remote = Instance.new("UnreliableRemoteEvent")
		remote.Name = key
		remote.Parent = folder
		unreliableCache[ck] = remote
		return remote
	end
	local found = folder:WaitForChild(key, 60)
	assert(found ~= nil and found:IsA("UnreliableRemoteEvent"), "[Spark.Network] UnreliableRemoteEvent not found: " .. ck)
	local remote = found :: UnreliableRemoteEvent
	unreliableCache[ck] = remote
	return remote
end
Network.GetUnreliableRemoteEvent = getUnreliableRemoteEvent

local function getPropertyUpdateEvent(service: string, member: string): RemoteEvent
	local ck = cacheKey(service, member, Kind.PropertyEvent)
	local cached = propEventCache[ck]
	if cached ~= nil then
		return cached
	end
	local folder = getServiceFolder(service)
	local key = leafName(member, Kind.PropertyEvent)
	if IS_SERVER then
		local existing = folder:FindFirstChild(key)
		if existing ~= nil and existing:IsA("RemoteEvent") then
			propEventCache[ck] = existing
			return existing
		end
		local remote = Instance.new("RemoteEvent")
		remote.Name = key
		remote.Parent = folder
		propEventCache[ck] = remote
		return remote
	end
	local found = folder:WaitForChild(key, 60)
	assert(found ~= nil and found:IsA("RemoteEvent"), "[Spark.Network] Property update event not found: " .. ck)
	local remote = found :: RemoteEvent
	propEventCache[ck] = remote
	return remote
end
Network.GetPropertyUpdateEvent = getPropertyUpdateEvent

local function getPropertyInitFunction(service: string, member: string): RemoteFunction
	local ck = cacheKey(service, member, Kind.PropertyFunction)
	local cached = propFunctionCache[ck]
	if cached ~= nil then
		return cached
	end
	local folder = getServiceFolder(service)
	local key = leafName(member, Kind.PropertyFunction)
	if IS_SERVER then
		local existing = folder:FindFirstChild(key)
		if existing ~= nil and existing:IsA("RemoteFunction") then
			propFunctionCache[ck] = existing
			return existing
		end
		local remote = Instance.new("RemoteFunction")
		remote.Name = key
		remote.Parent = folder
		propFunctionCache[ck] = remote
		return remote
	end
	local found = folder:WaitForChild(key, 60)
	assert(found ~= nil and found:IsA("RemoteFunction"), "[Spark.Network] Property init function not found: " .. ck)
	local remote = found :: RemoteFunction
	propFunctionCache[ck] = remote
	return remote
end
Network.GetPropertyInitFunction = getPropertyInitFunction

function Network.Release(service: string, member: string): ()
	eventCache[cacheKey(service, member, Kind.RemoteEvent)] = nil
	functionCache[cacheKey(service, member, Kind.RemoteFunction)] = nil
	unreliableCache[cacheKey(service, member, Kind.Unreliable)] = nil
	propEventCache[cacheKey(service, member, Kind.PropertyEvent)] = nil
	propFunctionCache[cacheKey(service, member, Kind.PropertyFunction)] = nil
end

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

if IS_SERVER then
	Players.PlayerRemoving:Connect(function(player: Player)
		rateBuckets[player] = nil
	end)
end

local function checkRate(player: Player, service: string, member: string): boolean
	assert(IS_SERVER, "[Spark.Network] CheckRate must be called on the server")
	local key = service .. "/" .. member
	local now = os.clock()

	local playerBuckets = rateBuckets[player]
	if playerBuckets == nil then
		playerBuckets = {}
		rateBuckets[player] = playerBuckets
	end

	local bucket = playerBuckets[key]
	if bucket == nil or now - bucket.windowStart >= Network.RateLimitWindow then
		playerBuckets[key] = { count = 1, windowStart = now }
		return true
	end

	if bucket.count >= Network.RateLimitMaxCalls then
		if bucket.count == Network.RateLimitMaxCalls then
			bucket.count += 1
			warn("[Spark.Network] Rate limit exceeded: " .. player.Name .. " -> " .. service .. "/" .. member)
		end
		return false
	end

	bucket.count += 1
	return true
end
Network.CheckRate = checkRate

return Network`,

        'Service.lua': `--!strict

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
	_serviceName: string,
	_memberName: string,
	Fire: (self: RemoteSignalInternal, player: Player, ...any) -> (),
	FireAll: (self: RemoteSignalInternal, ...any) -> (),
	FireExcept: (self: RemoteSignalInternal, except: Player, ...any) -> (),
	Connect: (self: RemoteSignalInternal, fn: (player: Player, ...any) -> ()) -> Signal.Connection,
	Destroy: (self: RemoteSignalInternal) -> (),
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
	_initFunc: RemoteFunction,
	_serviceName: string,
	_memberName: string,
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
	local conn = self._conn
	if conn ~= nil then
		conn:Disconnect()
		self._conn = nil
	end
	self._signal:Destroy()
	self._remote:Destroy()
	Network.Release(self._serviceName, self._memberName)
end
RemoteSignalClass.Destroy = rsDestroy

local function createSignal(remote: RemoteEvent, serviceName: string, memberName: string): RemoteSignalInternal
	local signal: Signal.Signal = Signal.new()
	local self: RemoteSignalInternal = setmetatable({
		_remote = remote,
		_signal = signal,
		_conn = nil,
		_serviceName = serviceName,
		_memberName = memberName,
	}, RemoteSignalClass) :: any

	self._conn = remote.OnServerEvent:Connect(function(player: Player, ...: any)
		if not Network.CheckRate(player, serviceName, memberName) then
			return
		end
		signal:Fire(player, ...)
	end)

	return self
end

local function createRemoteSignal(serviceName: string, memberName: string): RemoteSignalInternal
	return createSignal(Network.GetRemoteEvent(serviceName, memberName), serviceName, memberName)
end

local function createUnreliableRemoteSignal(serviceName: string, memberName: string): RemoteSignalInternal
	local remote: UnreliableRemoteEvent = Network.GetUnreliableRemoteEvent(serviceName, memberName)
	return createSignal(remote :: any, serviceName, memberName)
end

local RemotePropertyClass = {}
RemotePropertyClass.__index = RemotePropertyClass

local propertyCleanupHandlers: { [RemotePropertyInternal]: (Player) -> () } = {}
local propertyCleanupConnected: boolean = false

local function ensurePropertyCleanupDispatcher(): ()
	if propertyCleanupConnected then
		return
	end
	propertyCleanupConnected = true
	Players.PlayerRemoving:Connect(function(player: Player)
		for _, handler in propertyCleanupHandlers do
			handler(player)
		end
	end)
end

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
	propertyCleanupHandlers[self] = nil
	table.clear(self._playerValues)
	self._updateEvent:Destroy()
	self._initFunc:Destroy()
	Network.Release(self._serviceName, self._memberName)
end
RemotePropertyClass.Destroy = rpDestroy

local function createRemoteProperty(serviceName: string, memberName: string, defaultValue: any): RemotePropertyInternal
	local updateEvent: RemoteEvent = Network.GetPropertyUpdateEvent(serviceName, memberName)
	local initFunc: RemoteFunction = Network.GetPropertyInitFunction(serviceName, memberName)

	local self: RemotePropertyInternal = setmetatable({
		_value = defaultValue,
		_playerValues = setmetatable({}, { __mode = "k" }) :: { [Player]: any },
		_updateEvent = updateEvent,
		_initFunc = initFunc,
		_serviceName = serviceName,
		_memberName = memberName,
	}, RemotePropertyClass) :: any

	initFunc.OnServerInvoke = function(player: Player): any
		if not Network.CheckRate(player, serviceName, memberName) then
			return nil
		end
		return rpGetFor(self, player)
	end

	ensurePropertyCleanupDispatcher()
	propertyCleanupHandlers[self] = function(player: Player)
		self._playerValues[player] = nil
	end

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
	assert(not config.Name:find("/"), "[Spark.Service] Service Name cannot contain '/': " .. config.Name)
	assert(createdServices[config.Name] == nil, "[Spark.Service] Duplicate Service name: " .. config.Name)
	if config.Client == nil then
		config.Client = {}
	end
	local service: Service = config :: any
	if service.Client.Server ~= nil then
		warn("[Spark.Service] '" .. service.Name .. "'.Client.Server is reserved and will be overwritten")
	end
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
		assert(
			not memberName:find("/"),
			"[Spark.Service] Client member name cannot contain '/': " .. service.Name .. "." .. memberName
		)

		if type(value) == "function" then
			local remote: RemoteFunction = Network.GetRemoteFunction(service.Name, memberName)
			local boundFn = value
			remote.OnServerInvoke = function(player: Player, ...: any): ...any
				if not Network.CheckRate(player, service.Name, memberName) then
					return nil
				end
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
			else
				warn(
					"[Spark.Service] '"
						.. service.Name
						.. "."
						.. memberName
						.. "' is a plain table and will not be exposed to clients; use CreateRemoteSignal/CreateUnreliableRemoteSignal/CreateRemoteProperty"
				)
			end
		else
			warn(
				"[Spark.Service] '"
					.. service.Name
					.. "."
					.. memberName
					.. "' has unsupported Client member type '"
					.. type(value)
					.. "' and will be ignored"
			)
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

        'Controller.lua': `--!strict

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

        'Server.lua': `--!strict

local ReplicatedStorage = game:GetService("ReplicatedStorage")
local ServerScriptService = game:GetService("ServerScriptService")

local Spark = require(ReplicatedStorage:WaitForChild("Spark"):WaitForChild("Spark"))

Spark.AddModules(ServerScriptService:WaitForChild("Services"))

Spark.Start():andThen(function()
	print("[Spark] Server started")
end):catch(function(err: any)
	warn("[Spark] Server startup error: " .. tostring(err))
end)`,

        'Client.lua': `--!strict

local ReplicatedStorage = game:GetService("ReplicatedStorage")

local Spark = require(ReplicatedStorage:WaitForChild("Spark"):WaitForChild("Spark"))

Spark.AddModules(ReplicatedStorage:WaitForChild("Controllers"))

Spark.Start():andThen(function()
	print("[Spark] Client started")
end):catch(function(err: any)
	warn("[Spark] Client startup error: " .. tostring(err))
end)`,

        'Promise.lua': `-[[
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
				}, "\\n")
			)
		end

		return table.concat(errorStrings, "\\n")
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
			context = "Promise created at:\\n\\n" .. traceback,
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
							"The Promise that was part of the array at index %d passed into Promise.each was already cancelled when Promise.each began.\\n\\nThat Promise was created at:\\n\\n%s",
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
					"Timeout of %d seconds exceeded.\\n:timeout() called at:\\n\\n%s",
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
				"When returning a Promise from andThen, extra arguments are " .. "discarded! See:\\n\\n%s",
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
						"The Promise at:\\n\\n%s\\n...Rejected because it was chained to the following Promise, which encountered an error:\\n",
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
			local message = string.format("Unhandled Promise rejection:\\n\\n%s\\n\\n%s", err, self._source)

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
			context = ":now() was called at:\\n\\n" .. traceback,
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

        'readme.md': `# Tink

Knit-style service/controller framework for Roblox. \`--!strict\` throughout, no dependency on the archived Knit codebase. Requires [evaera/roblox-lua-promise](https://github.com/evaera/roblox-lua-promise).

Built-in: per-player rate limiting on every remote, fault-isolated startup (one broken service doesn't take the rest down), timeouts on hung \`OnInit\`/\`OnStart\` promises.

## Layout

\`\`\`
ReplicatedStorage/
└── Spark/
    ├── Spark       ModuleScript — core
    ├── Signal      ModuleScript
    ├── Network     ModuleScript
    ├── Service     ModuleScript
    ├── Controller  ModuleScript
    └── Promise     ModuleScript — paste lib/init.lua from evaera/roblox-lua-promise

ReplicatedStorage/Controllers/     folder, client controllers
ServerScriptService/Server         Script, entry point
ServerScriptService/Services/      folder, server services
StarterPlayer/StarterPlayerScripts/Client   LocalScript, entry point
\`\`\`

Paste \`Spark.luau\` → \`Spark/Spark\`, \`Signal.luau\` → \`Spark/Signal\`, \`Network.luau\` → \`Spark/Network\`, \`Service.luau\` → \`Spark/Service\`, \`Controller.luau\` → \`Spark/Controller\`, \`Server.luau\` → \`ServerScriptService/Server\`, \`Client.luau\` → \`StarterPlayerScripts/Client\`.

## Service

\`\`\`lua
--!strict
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Spark = require(ReplicatedStorage.Spark.Spark)

local PointsService = Spark.CreateService {
    Name = "PointsService",

    Client = {
        GetPoints = function(self, player: Player): number
            return 100
        end,

        PointsChanged = Spark.CreateRemoteSignal(),
        PositionSync = Spark.CreateUnreliableRemoteSignal(),
        Multiplier = Spark.CreateRemoteProperty(1),
    },
}

function PointsService:OnInit()
    -- own setup only; other services are not guaranteed to exist yet
end

function PointsService:OnStart()
    self.Client.Multiplier:Set(2)
    self.Client.Multiplier:SetFor(somePlayer, 5)
    self.Client.PointsChanged:Fire(somePlayer, 200)
    self.Client.PointsChanged:FireAll(200)
end

function PointsService:OnPlayerRemoving(player: Player)
end

return PointsService
\`\`\`

\`self\` inside a \`Client\` method is the service's \`Client\` table, not the service itself — reach the service with \`self.Server\` (matches Knit's convention). \`OnInit\`/\`OnStart\` may return a Promise to delay the next stage for that object only.

## Controller

\`\`\`lua
--!strict
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Spark = require(ReplicatedStorage.Spark.Spark)

local PointsController = Spark.CreateController { Name = "PointsController" }

function PointsController:OnStart()
    local PointsService = Spark.GetService("PointsService")

    PointsService:GetPoints():andThen(function(points)
        print("My points:", points)
    end)

    PointsService.PointsChanged:Connect(function(points)
        print("Points updated:", points)
    end)

    PointsService.Multiplier:Observe(function(value)
        print("Multiplier is now:", value)
    end)

    local current = PointsService.Multiplier:Get() -- yields if not loaded yet
end

return PointsController
\`\`\`

Cross-references: \`Spark.GetServerService(name)\` from a service, \`Spark.GetController(name)\` from a controller.

## Remotes and rate limiting

Every service gets a subfolder under \`ReplicatedStorage.SparkRemotes.<ServiceName>\`, one Instance per \`Client\` member named \`<member>/<kind>\` (\`RE\`/\`RF\`/\`URE\`/\`RPE\`/\`RPF\`). Useful when you need to find a specific remote in the Explorer while debugging.

Every RemoteEvent, UnreliableRemoteEvent and Client-exposed method checks a per-player rate limit before the handler runs: \`Network.RateLimitMaxCalls\` (default 40) calls per \`Network.RateLimitWindow\` seconds (default 1), fixed window. Calls over the limit are dropped — events silently, methods return \`nil\` — and the first violation per window logs a \`warn\`. This does not replace argument validation; it only bounds call frequency. Tune both fields on \`Spark.Util.Network\` before \`Spark.Start()\`.

\`RemoteSignal:Destroy()\` / \`RemoteProperty:Destroy()\` destroy the backing Instances and clear the Network cache entry, so a later re-creation under the same service/member name gets fresh Instances rather than the stale ones.

## Lifecycle

\`\`\`
Server                              Client
AddModules (require all services)   AddModules (require all controllers)
        │                                    │
_bindClient (create remotes)          WaitForReady
        │                                    │
  CreateReadyMarker                  OnInit (all controllers)
        │                                    │
  OnInit (all services)             OnStart (all controllers)
        │
  OnStart (all services)
\`\`\`

If a service/controller's \`OnInit\` or \`OnStart\` throws, its returned Promise rejects, or it runs past \`Spark.StageTimeoutSeconds\` (default 30) — that object alone is marked failed and skipped from \`OnStart\` on. Every other object proceeds normally. The error is logged with a full \`debug.traceback\`, not just the error string.

## API

### Spark

| Member | Side | |
|---|---|---|
| \`CreateService(config)\` | server | register a service |
| \`CreateController(config)\` | client | register a controller |
| \`CreateRemoteSignal()\` | server | \`Client\` field marker, reliable event |
| \`CreateUnreliableRemoteSignal()\` | server | \`Client\` field marker, UnreliableRemoteEvent |
| \`CreateRemoteProperty(default)\` | server | \`Client\` field marker, replicated value |
| \`AddModules(parent)\` | both | require every ModuleScript under \`parent\` |
| \`Start()\` | both | boots the framework, returns a Promise |
| \`OnStart()\` | both | the same Promise, callable any time after \`Start()\` |
| \`GetService(name)\` | client | proxy for a service |
| \`GetController(name)\` | client | registered controller |
| \`GetServerService(name)\` | server | registered service |
| \`StageTimeoutSeconds\` | both | see Lifecycle; set before \`Start()\` |
| \`Util.Signal\` / \`Util.Promise\` / \`Util.Network\` | both | the underlying modules |

### RemoteSignal (server)

\`Fire(player, ...)\` · \`FireAll(...)\` · \`FireExcept(except, ...)\` · \`Connect(fn)\` — \`fn(player, ...)\` on client→server fires · \`Destroy()\`

### RemoteProperty (server)

\`Set(value)\` — all clients without a per-player override · \`SetFor(player, value)\` · \`SetFilter(predicate, value)\` · \`Get()\` · \`GetFor(player)\` · \`Destroy()\`

### RemoteProperty proxy (client)

\`Get()\` — yields until the first value has loaded · \`Observe(fn)\` — fires immediately with the current value, then on every change · \`Destroy()\`

### Signal (\`Spark.Util.Signal\`)

\`Signal.new()\` · \`Connect(fn)\` · \`Once(fn)\` · \`Wait()\` · \`Fire(...)\` · \`DisconnectAll()\` · \`Destroy()\`

## License

MIT`
      }
    },

    inventory: {
      name: 'Inventory slot UI & custom interact prompt',
      files: {
        'InventoryServer.lua': `--!strict
local Players = game:GetService("Players")
local DataStoreService = game:GetService("DataStoreService")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local ServerStorage = game:GetService("ServerStorage")
local CollectionService = game:GetService("CollectionService")
local HttpService = game:GetService("HttpService")

local SERVER_DISTANCE_TOLERANCE = 5
local PICKUP_COOLDOWN_SECONDS = 0.1
local SESSION_HEARTBEAT_INTERVAL = 20
local SESSION_TIMEOUT_SECONDS = 60
local SESSION_CLAIM_RETRIES = 5
local SESSION_CLAIM_RETRY_WAIT = 2
local PERSIST_LOCK_WAIT_TIMEOUT = 5
local BIND_TO_CLOSE_TIMEOUT = 20

local SESSION_ID: string = HttpService:GenerateGUID(false)

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

local pickupFeedback: RemoteEvent = Instance.new("RemoteEvent")
pickupFeedback.Name = "PickupFeedback"
pickupFeedback.Parent = remoteFolder

local dropFeedback: RemoteEvent = Instance.new("RemoteEvent")
dropFeedback.Name = "DropFeedback"
dropFeedback.Parent = remoteFolder

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

local function claimSession(userId: number): (boolean, boolean, Inventory)
	local key: string = GameConfig.DATASTORE_KEY_PREFIX .. tostring(userId)
	local claimed: boolean = false
	local resultInv: Inventory = createEmptyInventory()

	local ok: boolean = pcall(function()
		dataStore:UpdateAsync(key, function(old: any): any
			local now: number = os.time()
			local oldInventoryRaw: any = nil
			local oldSession: any = nil

			if type(old) == "table" then
				if old.session ~= nil or old.inventory ~= nil then
					oldInventoryRaw = old.inventory
					oldSession = old.session
				else
					oldInventoryRaw = old
				end
			end

			if type(oldSession) == "table" and type(oldSession.id) == "string" and type(oldSession.updatedAt) == "number" then
				if oldSession.id ~= SESSION_ID and (now - oldSession.updatedAt) < SESSION_TIMEOUT_SECONDS then
					claimed = false
					return nil
				end
			end

			local inv: Inventory = createEmptyInventory()
			if type(oldInventoryRaw) == "table" then
				for i = 1, GameConfig.MAX_SLOTS do
					local val: any = oldInventoryRaw[tostring(i)] or oldInventoryRaw[i]
					if type(val) == "string" and validItems[val] then
						inv[i] = val
					end
				end
			end

			local saveTable: { [string]: string } = {}
			for i = 1, GameConfig.MAX_SLOTS do
				if inv[i] then
					saveTable[tostring(i)] = inv[i] :: string
				end
			end

			claimed = true
			resultInv = inv
			return {
				inventory = saveTable,
				session = { id = SESSION_ID, updatedAt = now },
			}
		end)
	end)

	return ok, claimed, resultInv
end

local function persistData(player: Player, releaseSession: boolean): (boolean, boolean)
	local userId: number = player.UserId

	local waited: number = 0
	while saveLock[userId] and waited < PERSIST_LOCK_WAIT_TIMEOUT do
		task.wait(0.1)
		waited += 0.1
	end
	if saveLock[userId] then
		return false, true
	end

	saveLock[userId] = true
	activeSaves += 1

	local inv: Inventory? = playerCache[player]
	if not inv then
		saveLock[userId] = false
		activeSaves -= 1
		return true, true
	end

	local key: string = GameConfig.DATASTORE_KEY_PREFIX .. tostring(userId)
	local saveTable: { [string]: string } = {}
	for i = 1, GameConfig.MAX_SLOTS do
		if inv[i] then
			saveTable[tostring(i)] = inv[i] :: string
		end
	end

	local sessionStolen: boolean = false
	local success: boolean, err: any = pcall(function()
		dataStore:UpdateAsync(key, function(old: any): any
			local oldSession: any = nil
			if type(old) == "table" and type(old.session) == "table" then
				oldSession = old.session
			end

			if type(oldSession) == "table" and oldSession.id ~= SESSION_ID then
				sessionStolen = true
				return nil
			end

			if releaseSession then
				return { inventory = saveTable, session = nil }
			end

			return { inventory = saveTable, session = { id = SESSION_ID, updatedAt = os.time() } }
		end)
	end)

	if not success then
		warn(\`[InventoryServer] Save failed for {userId}: {tostring(err)}\`)
	end

	saveLock[userId] = false
	activeSaves -= 1

	return success, not sessionStolen
end

local function startHeartbeat(player: Player)
	task.spawn(function()
		while player:IsDescendantOf(Players) do
			task.wait(SESSION_HEARTBEAT_INTERVAL)
			if not player:IsDescendantOf(Players) then
				break
			end
			local requestOk: boolean, stillOwns: boolean = persistData(player, false)
			if requestOk and not stillOwns then
				player:Kick("Your save data is now active on another server. Please rejoin.")
				break
			end
		end
	end)
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
	pickupFeedback:FireClient(player)
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
	dropFeedback:FireClient(player)
end)

local function onPlayerAdded(player: Player)
	local userId: number = player.UserId
	local inv: Inventory? = nil

	for attempt = 1, SESSION_CLAIM_RETRIES do
		if not player:IsDescendantOf(Players) then return end

		local ok: boolean, claimed: boolean, loadedInv: Inventory = claimSession(userId)
		if ok and claimed then
			inv = loadedInv
			break
		end

		if attempt < SESSION_CLAIM_RETRIES then
			task.wait(SESSION_CLAIM_RETRY_WAIT)
		end
	end

	if not player:IsDescendantOf(Players) then return end

	if not inv then
		player:Kick("Could not load your save data (it may still be active on another server). Please rejoin in a moment.")
		return
	end

	playerCache[player] = inv
	playerEquipped[player] = nil
	startHeartbeat(player)

	local function setupCharacter(character: Model)
		playerEquipped[player] = nil

		local humanoid: Humanoid? = character:WaitForChild("Humanoid", 10) :: Humanoid?
		if not humanoid then return end

		task.defer(function()
			if player:IsDescendantOf(Players) then
				sendSync(player)
			end
		end)

		humanoid.Died:Connect(function()
			local hadEquipped: boolean = playerEquipped[player] ~= nil
			destroyEquippedTool(player)
			playerEquipped[player] = nil
			if hadEquipped and player:IsDescendantOf(Players) then
				equippedSync:FireClient(player, nil)
			end
		end)
	end

	player.CharacterAdded:Connect(setupCharacter)

	if player.Character then
		setupCharacter(player.Character)
	end
end

local function onPlayerRemoving(player: Player)
	if playerCache[player] then
		persistData(player, true)
	end
	playerCache[player] = nil
	playerEquipped[player] = nil
	pickupCooldown[player] = nil
	saveLock[player.UserId] = nil
end

Players.PlayerAdded:Connect(onPlayerAdded)
Players.PlayerRemoving:Connect(onPlayerRemoving)

for _, player: Player in Players:GetPlayers() do
	task.spawn(onPlayerAdded, player)
end

game:BindToClose(function()
	for player: Player, _ in pairs(playerCache) do
		task.spawn(persistData, player, true)
	end

	local maxWait: number = tick() + BIND_TO_CLOSE_TIMEOUT
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
local dropFeedback: RemoteEvent = remoteFolder:WaitForChild("DropFeedback") :: RemoteEvent

local sfxFolder: Folder = ReplicatedStorage:WaitForChild("SFX") :: Folder
local inventorySfxFolder: Folder = sfxFolder:WaitForChild("Inventory") :: Folder
local equipSoundTemplate: Sound = inventorySfxFolder:WaitForChild("ItemEquip") :: Sound
local equipSound: Sound = equipSoundTemplate:Clone()
equipSound.Parent = playerGui

local dropSoundTemplate: Sound = inventorySfxFolder:WaitForChild("ItemDrop") :: Sound
local dropSound: Sound = dropSoundTemplate:Clone()
dropSound.Parent = playerGui

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
local EQUIPPED_SLOT_COLOR: Color3 = Color3.fromRGB(40, 40, 40)

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
	equipSound.TimePosition = 0
	equipSound:Play()
	updateUI()
end)

dropFeedback.OnClientEvent:Connect(function()
	dropSound.TimePosition = 0
	dropSound:Play()
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
local pickupFeedback: RemoteEvent = remoteFolder:WaitForChild("PickupFeedback") :: RemoteEvent

local sfxFolder: Folder = ReplicatedStorage:WaitForChild("SFX") :: Folder
local inventorySfxFolder: Folder = sfxFolder:WaitForChild("Inventory") :: Folder
local pickupSoundTemplate: Sound = inventorySfxFolder:WaitForChild("ItemPickup") :: Sound
local pickupSound: Sound = pickupSoundTemplate:Clone()
pickupSound.Parent = playerGui

local promptGui: ScreenGui = playerGui:WaitForChild("InteractionPrompt") :: ScreenGui
local promptFrame: Frame = promptGui:WaitForChild("PromptFrame") :: Frame
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

pickupFeedback.OnClientEvent:Connect(function()
	pickupSound.TimePosition = 0
	pickupSound:Play()
end)`,

        'FootstepClient.lua': `--!strict
local Players = game:GetService("Players")
local RunService = game:GetService("RunService")
local ReplicatedStorage = game:GetService("ReplicatedStorage")

local WALK_ANIMATION_ASSET_ID = "130156238002743"
local FOOTSTEP_TIMES = { 0.14, 0.76, 1.10, 1.67, 2.14, 2.76 }
local DEFAULT_FOOTSTEP_SOUND_NAMES = { Running = true, Climbing = true }

local sfxFolder: Folder = ReplicatedStorage:WaitForChild("SFX") :: Folder
local footstepsFolder: Folder = sfxFolder:WaitForChild("Footsteps") :: Folder
local footstepSoundTemplate: Sound = footstepsFolder:WaitForChild("Footstep_Carpet") :: Sound

local activeConnections: { [Model]: { RBXScriptConnection } } = {}

local function extractAssetId(animationId: string): string?
	return animationId:match("%d+")
end

local function addConnection(character: Model, connection: RBXScriptConnection)
	local connections = activeConnections[character]
	if not connections then
		connections = {}
		activeConnections[character] = connections
	end
	table.insert(connections, connection)
end

local function removeConnection(character: Model, connection: RBXScriptConnection)
	local connections = activeConnections[character]
	if not connections then return end
	for i = #connections, 1, -1 do
		if connections[i] == connection then
			table.remove(connections, i)
			break
		end
	end
end

local function stopWatchingCharacter(character: Model)
	local connections = activeConnections[character]
	if not connections then return end
	activeConnections[character] = nil
	for _, connection in ipairs(connections) do
		connection:Disconnect()
	end
end

local function watchWalkTrack(character: Model, track: AnimationTrack, sound: Sound)
	local lastPosition = track.TimePosition
	local heartbeatConnection: RBXScriptConnection
	heartbeatConnection = RunService.Heartbeat:Connect(function()
		if not track.IsPlaying then
			heartbeatConnection:Disconnect()
			removeConnection(character, heartbeatConnection)
			return
		end

		local position = track.TimePosition
		for _, stepTime in ipairs(FOOTSTEP_TIMES) do
			local crossed: boolean
			if position >= lastPosition then
				crossed = stepTime > lastPosition and stepTime <= position
			else
				crossed = stepTime > lastPosition or stepTime <= position
			end
			if crossed then
				sound.TimePosition = 0
				sound:Play()
			end
		end
		lastPosition = position
	end)

	addConnection(character, heartbeatConnection)
end

local function suppressDefaultSound(sound: Sound)
	sound:Stop()
	sound:Destroy()
end

local function watchDefaultSounds(character: Model, rootPart: BasePart)
	for _, child in ipairs(rootPart:GetChildren()) do
		if child:IsA("Sound") and DEFAULT_FOOTSTEP_SOUND_NAMES[child.Name] then
			suppressDefaultSound(child)
		end
	end

	local connection = rootPart.ChildAdded:Connect(function(child: Instance)
		if child:IsA("Sound") and DEFAULT_FOOTSTEP_SOUND_NAMES[child.Name] then
			suppressDefaultSound(child)
		end
	end)

	addConnection(character, connection)
end

local function setupCharacter(character: Model)
	local humanoid = character:WaitForChild("Humanoid", 10) :: Humanoid?
	if not humanoid then return end
	if humanoid.RigType ~= Enum.HumanoidRigType.R6 then return end

	local rootPart = character:WaitForChild("HumanoidRootPart", 10) :: BasePart?
	if not rootPart then return end

	watchDefaultSounds(character, rootPart)

	local animator = humanoid:FindFirstChildOfClass("Animator") or humanoid:WaitForChild("Animator", 10)
	if not animator or not animator:IsA("Animator") then return end

	local sound = footstepSoundTemplate:Clone()
	sound.Parent = rootPart

	local animationPlayedConnection = animator.AnimationPlayed:Connect(function(track: AnimationTrack)
		local animation = track.Animation
		if not animation then return end
		if extractAssetId(animation.AnimationId) ~= WALK_ANIMATION_ASSET_ID then return end
		watchWalkTrack(character, track, sound)
	end)

	addConnection(character, animationPlayedConnection)
end

local function onPlayerAdded(player: Player)
	player.CharacterAdded:Connect(setupCharacter)
	player.CharacterRemoving:Connect(stopWatchingCharacter)
	if player.Character then
		setupCharacter(player.Character)
	end
end

local function onPlayerRemoving(player: Player)
	local character = player.Character
	if character then
		stopWatchingCharacter(character)
	end
end

Players.PlayerAdded:Connect(onPlayerAdded)
Players.PlayerRemoving:Connect(onPlayerRemoving)
for _, player: Player in ipairs(Players:GetPlayers()) do
	onPlayerAdded(player)
end`,

        'SetWalkAnimation.lua': `local Players = game:GetService("Players")

local WALK_ANIMATION_ID = "rbxassetid://130156238002743"

local function onCharacterAdded(character)
	local humanoid = character:WaitForChild("Humanoid")
	if humanoid.RigType ~= Enum.HumanoidRigType.R6 then
		return
	end

	local animate = character:WaitForChild("Animate")
	local walkAnim = animate:WaitForChild("walk"):WaitForChild("WalkAnim")
	walkAnim.AnimationId = WALK_ANIMATION_ID
end

local function onPlayerAdded(player)
	player.CharacterAdded:Connect(onCharacterAdded)
	if player.Character then
		onCharacterAdded(player.Character)
	end
end

Players.PlayerAdded:Connect(onPlayerAdded)

for _, player in ipairs(Players:GetPlayers()) do
	onPlayerAdded(player)
end
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

return GameConfig`,

        'readme.md': `# 📁 Project Structure
\`\`\`
ReplicatedStorage/
└ GameConfig                    ← ModuleScript
└ InventoryRemotes/
   └ EquipEvent                 ← RemoteEvent
   └ DropEvent                  ← RemoteEvent
   └ SyncInventory              ← RemoteEvent
   └ EquippedSync               ← RemoteEvent
   └ PickupEvent                ← RemoteEvent
   └ PickupFeedback             ← RemoteEvent
└ SFX/
   └ Footsteps/
      └ Footstep_Carpet         ← Sound
   └ Inventory/
      └ ItemPickup              ← Sound
      └ ItemEquip               ← Sound

ServerScriptService/
└ InventoryServer                ← Script
└ SetWalkAnimation               ← Script

StarterPlayerScripts/
└ InventoryClient                ← LocalScript
└ InteractionClient               ← LocalScript
└ FootstepClient                 ← LocalScript

Workspace/
└ Items/
   └ InventoryItem_01           ← Part
   └ InventoryItem_02           ← Part
   └ InventoryItem_03           ← Part
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

    const grids = $$('.sys-grid, .sk-grid, .pay-grid, .info-grid, .scope-row');
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
