import { type Model, modelsAreEqual } from "@earendil-works/pi-ai";
import {
	Container,
	type Focusable,
	fuzzyFilter,
	getKeybindings,
	Input,
	Spacer,
	Text,
	type TUI,
} from "@earendil-works/pi-tui";
import type { ModelRegistry } from "../../../core/model-registry.ts";
import type { SettingsManager } from "../../../core/settings-manager.ts";
import { getModelSearchText } from "../model-search.ts";
import { theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { keyHint } from "./keybinding-hints.ts";

interface ModelItem {
	provider: string;
	id: string;
	model: Model<any>;
}

interface ScopedModelItem {
	model: Model<any>;
	thinkingLevel?: string;
}

type ModelScope = "all" | "scoped";

interface VercelGatewayModelMetadata {
	id?: unknown;
	name?: unknown;
	released?: unknown;
	owned_by?: unknown;
}

const VERCEL_MODELS_URL = "https://ai-gateway.vercel.sh/v1/models";
let vercelReleaseDatesPromise: Promise<Map<string, string>> | undefined;

const PROVIDER_TO_VERCEL_OWNER: Record<string, string> = {
	"amazon-bedrock": "anthropic",
	anthropic: "anthropic",
	google: "google",
	"google-vertex": "google",
	openai: "openai",
	"openai-codex": "openai",
	xai: "xai",
	groq: "groq",
	mistral: "mistral",
	moonshotai: "moonshotai",
	"moonshotai-cn": "moonshotai",
	zai: "zai",
	"zai-coding-cn": "zai",
};

const MODEL_COLUMN_WIDTH = 30;
const CONTEXT_COLUMN_WIDTH = 8;
const PRICE_COLUMN_WIDTH = 9;
const PROVIDER_COLUMN_WIDTH = 18;
const RELEASE_DATE_COLUMN_WIDTH = 12;

function truncateCell(value: string, width: number): string {
	if (value.length <= width) return value.padEnd(width);
	if (width <= 1) return value.slice(0, width);
	return `${value.slice(0, width - 1)}…`;
}

function formatTokenCount(count: number): string {
	if (!Number.isFinite(count) || count <= 0) return "-";
	if (count >= 1_000_000) {
		const millions = count / 1_000_000;
		return millions % 1 === 0 ? `${millions}M` : `${millions.toFixed(1)}M`;
	}
	if (count >= 1_000) {
		const thousands = count / 1_000;
		return thousands % 1 === 0 ? `${thousands}K` : `${thousands.toFixed(1)}K`;
	}
	return count.toString();
}

function formatPrice(price: number): string {
	if (!Number.isFinite(price)) return "-";
	if (price === 0) return "$0/M";
	const digits = price < 0.01 ? 4 : price < 1 ? 3 : 2;
	return `$${price.toFixed(digits).replace(/\.0+$|(?<=\.\d*[1-9])0+$/u, "")}/M`;
}

function formatDateParts(year: number, month: number, day: number): string | undefined {
	const date = new Date(Date.UTC(year, month - 1, day));
	if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
		return undefined;
	}
	return `${month.toString().padStart(2, "0")}/${day.toString().padStart(2, "0")}/${year}`;
}

function formatDateValue(value: unknown): string | undefined {
	if (typeof value === "number" && Number.isFinite(value)) {
		const milliseconds = value < 10_000_000_000 ? value * 1000 : value;
		const date = new Date(milliseconds);
		return formatDateParts(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
	}
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	const separated = /(?:^|\D)(\d{4})[-_.](\d{2})[-_.](\d{2})(?:\D|$)/u.exec(trimmed);
	if (separated) {
		return formatDateParts(Number(separated[1]), Number(separated[2]), Number(separated[3]));
	}
	const compact = /(?:^|\D)(\d{4})(\d{2})(\d{2})(?:\D|$)/u.exec(trimmed);
	if (compact) {
		return formatDateParts(Number(compact[1]), Number(compact[2]), Number(compact[3]));
	}
	return undefined;
}

function normalizeVercelModelKey(value: string): string {
	return value
		.toLowerCase()
		.replace(/^global\./u, "")
		.replace(/^models\//u, "")
		.replace(/[._]/gu, "-");
}

function addVercelReleaseDateKey(dates: Map<string, string>, key: string, date: string): void {
	if (!key) return;
	const normalized = normalizeVercelModelKey(key);
	if (!dates.has(normalized)) {
		dates.set(normalized, date);
	}
}

async function getVercelReleaseDates(): Promise<Map<string, string>> {
	if (process.env.PI_OFFLINE === "1") return new Map<string, string>();
	vercelReleaseDatesPromise ??= fetch(VERCEL_MODELS_URL)
		.then(async (response) => {
			if (!response.ok) return new Map<string, string>();
			const data = (await response.json()) as { data?: unknown };
			const items = Array.isArray(data.data) ? data.data : [];
			const dates = new Map<string, string>();

			for (const rawItem of items) {
				const item = rawItem as VercelGatewayModelMetadata;
				if (typeof item.id !== "string") continue;

				const date = formatDateValue(item.released);
				if (!date) continue;

				addVercelReleaseDateKey(dates, item.id, date);
				const slashIndex = item.id.indexOf("/");
				if (slashIndex >= 0) {
					addVercelReleaseDateKey(dates, item.id.slice(slashIndex + 1), date);
				}
				if (typeof item.name === "string") {
					addVercelReleaseDateKey(dates, item.name, date);
				}
				if (typeof item.owned_by === "string" && slashIndex >= 0) {
					addVercelReleaseDateKey(dates, `${item.owned_by}/${item.id.slice(slashIndex + 1)}`, date);
				}
			}

			return dates;
		})
		.catch(() => new Map<string, string>());
	return vercelReleaseDatesPromise;
}

function getReleaseDate(item: ModelItem, vercelReleaseDates: ReadonlyMap<string, string>): string {
	const vercelOwner = PROVIDER_TO_VERCEL_OWNER[item.provider];
	const keys = [
		item.id,
		item.model.name,
		vercelOwner ? `${vercelOwner}/${item.id}` : undefined,
		item.provider === "vercel-ai-gateway" ? item.id : undefined,
	].filter((key): key is string => typeof key === "string" && key.length > 0);

	for (const key of keys) {
		const date = vercelReleaseDates.get(normalizeVercelModelKey(key));
		if (date) return date;
	}
	return "-";
}

function formatModelTableRow(item: ModelItem, vercelReleaseDates: ReadonlyMap<string, string>): string {
	const modelName = item.model.name || item.id;
	return [
		truncateCell(modelName, MODEL_COLUMN_WIDTH),
		formatTokenCount(item.model.contextWindow).padStart(CONTEXT_COLUMN_WIDTH),
		formatPrice(item.model.cost.input).padStart(PRICE_COLUMN_WIDTH),
		formatPrice(item.model.cost.output).padStart(PRICE_COLUMN_WIDTH),
		truncateCell(item.provider, PROVIDER_COLUMN_WIDTH),
		getReleaseDate(item, vercelReleaseDates).padEnd(RELEASE_DATE_COLUMN_WIDTH),
	].join("  ");
}

function formatModelTableHeader(): string {
	return [
		"Model".padEnd(MODEL_COLUMN_WIDTH),
		"Context".padStart(CONTEXT_COLUMN_WIDTH),
		"Input".padStart(PRICE_COLUMN_WIDTH),
		"Output".padStart(PRICE_COLUMN_WIDTH),
		"Provider".padEnd(PROVIDER_COLUMN_WIDTH),
		"Release date".padEnd(RELEASE_DATE_COLUMN_WIDTH),
	].join("  ");
}

/**
 * Component that renders a model selector with search
 */
export class ModelSelectorComponent extends Container implements Focusable {
	private searchInput: Input;

	// Focusable implementation - propagate to searchInput for IME cursor positioning
	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.searchInput.focused = value;
	}
	private listContainer: Container;
	private allModels: ModelItem[] = [];
	private scopedModelItems: ModelItem[] = [];
	private activeModels: ModelItem[] = [];
	private filteredModels: ModelItem[] = [];
	private selectedIndex: number = 0;
	private currentModel?: Model<any>;
	private settingsManager: SettingsManager;
	private modelRegistry: ModelRegistry;
	private onSelectCallback: (model: Model<any>) => void;
	private onCancelCallback: () => void;
	private errorMessage?: string;
	private tui: TUI;
	private vercelReleaseDates: ReadonlyMap<string, string> = new Map();
	private scopedModels: ReadonlyArray<ScopedModelItem>;
	private scope: ModelScope = "all";
	private scopeText?: Text;
	private scopeHintText?: Text;

	constructor(
		tui: TUI,
		currentModel: Model<any> | undefined,
		settingsManager: SettingsManager,
		modelRegistry: ModelRegistry,
		scopedModels: ReadonlyArray<ScopedModelItem>,
		onSelect: (model: Model<any>) => void,
		onCancel: () => void,
		initialSearchInput?: string,
	) {
		super();

		this.tui = tui;
		this.currentModel = currentModel;
		this.settingsManager = settingsManager;
		this.modelRegistry = modelRegistry;
		this.scopedModels = scopedModels;
		this.scope = scopedModels.length > 0 ? "scoped" : "all";
		this.onSelectCallback = onSelect;
		this.onCancelCallback = onCancel;

		// Add top border
		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));

		// Add hint about model filtering
		if (scopedModels.length > 0) {
			this.scopeText = new Text(this.getScopeText(), 0, 0);
			this.addChild(this.scopeText);
			this.scopeHintText = new Text(this.getScopeHintText(), 0, 0);
			this.addChild(this.scopeHintText);
		} else {
			const hintText = "Only showing models from configured providers. Use /login to add providers.";
			this.addChild(new Text(theme.fg("warning", hintText), 0, 0));
		}
		this.addChild(new Spacer(1));

		// Create search input
		this.searchInput = new Input();
		if (initialSearchInput) {
			this.searchInput.setValue(initialSearchInput);
		}
		this.searchInput.onSubmit = () => {
			// Enter on search input selects the first filtered item
			if (this.filteredModels[this.selectedIndex]) {
				this.handleSelect(this.filteredModels[this.selectedIndex].model);
			}
		};
		this.addChild(this.searchInput);

		this.addChild(new Spacer(1));

		// Create list container
		this.listContainer = new Container();
		this.addChild(this.listContainer);

		this.addChild(new Spacer(1));

		// Add bottom border
		this.addChild(new DynamicBorder());

		// Load models and do initial render
		this.loadModels().then(() => {
			if (initialSearchInput) {
				this.filterModels(initialSearchInput);
			} else {
				this.updateList();
			}
			// Request re-render after models are loaded
			this.tui.requestRender();
			void this.loadVercelReleaseDates();
		});
	}

	private async loadModels(): Promise<void> {
		let models: ModelItem[];

		// Refresh to pick up any changes to models.json
		this.modelRegistry.refresh();

		// Check for models.json errors
		const loadError = this.modelRegistry.getError();
		if (loadError) {
			this.errorMessage = loadError;
		}

		// Load available models (built-in models still work even if models.json failed)
		try {
			const availableModels = await this.modelRegistry.getAvailable();
			models = availableModels.map((model: Model<any>) => ({
				provider: model.provider,
				id: model.id,
				model,
			}));
		} catch (error) {
			this.allModels = [];
			this.scopedModelItems = [];
			this.activeModels = [];
			this.filteredModels = [];
			this.errorMessage = error instanceof Error ? error.message : String(error);
			return;
		}

		this.allModels = this.sortModels(models);
		this.scopedModels = this.scopedModels.map((scoped) => {
			const refreshed = this.modelRegistry.find(scoped.model.provider, scoped.model.id);
			return refreshed ? { ...scoped, model: refreshed } : scoped;
		});
		this.scopedModelItems = this.scopedModels.map((scoped) => ({
			provider: scoped.model.provider,
			id: scoped.model.id,
			model: scoped.model,
		}));
		this.activeModels = this.scope === "scoped" ? this.scopedModelItems : this.allModels;
		this.filteredModels = this.activeModels;
		const currentIndex = this.filteredModels.findIndex((item) => modelsAreEqual(this.currentModel, item.model));
		this.selectedIndex =
			currentIndex >= 0 ? currentIndex : Math.min(this.selectedIndex, Math.max(0, this.filteredModels.length - 1));
	}

	private async loadVercelReleaseDates(): Promise<void> {
		this.vercelReleaseDates = await getVercelReleaseDates();
		this.updateList();
		this.tui.requestRender();
	}

	private sortModels(models: ModelItem[]): ModelItem[] {
		const sorted = [...models];
		// Sort: current model first, then by provider
		sorted.sort((a, b) => {
			const aIsCurrent = modelsAreEqual(this.currentModel, a.model);
			const bIsCurrent = modelsAreEqual(this.currentModel, b.model);
			if (aIsCurrent && !bIsCurrent) return -1;
			if (!aIsCurrent && bIsCurrent) return 1;
			return a.provider.localeCompare(b.provider);
		});
		return sorted;
	}

	private getScopeText(): string {
		const allText = this.scope === "all" ? theme.fg("accent", "all") : theme.fg("muted", "all");
		const scopedText = this.scope === "scoped" ? theme.fg("accent", "scoped") : theme.fg("muted", "scoped");
		return `${theme.fg("muted", "Scope: ")}${allText}${theme.fg("muted", " | ")}${scopedText}`;
	}

	private getScopeHintText(): string {
		return keyHint("tui.input.tab", "scope") + theme.fg("muted", " (all/scoped)");
	}

	private setScope(scope: ModelScope): void {
		if (this.scope === scope) return;
		this.scope = scope;
		this.activeModels = this.scope === "scoped" ? this.scopedModelItems : this.allModels;
		const currentIndex = this.activeModels.findIndex((item) => modelsAreEqual(this.currentModel, item.model));
		this.selectedIndex = currentIndex >= 0 ? currentIndex : 0;
		this.filterModels(this.searchInput.getValue());
		if (this.scopeText) {
			this.scopeText.setText(this.getScopeText());
		}
	}

	private filterModels(query: string): void {
		this.filteredModels = query
			? fuzzyFilter(this.activeModels, query, ({ id, provider, model }) =>
					getModelSearchText({ id, provider, name: model.name }),
				)
			: this.activeModels;
		this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.filteredModels.length - 1));
		this.updateList();
	}

	private updateList(): void {
		this.listContainer.clear();

		const maxVisible = 10;
		const startIndex = Math.max(
			0,
			Math.min(this.selectedIndex - Math.floor(maxVisible / 2), this.filteredModels.length - maxVisible),
		);
		const endIndex = Math.min(startIndex + maxVisible, this.filteredModels.length);

		if (this.filteredModels.length > 0) {
			this.listContainer.addChild(new Text(theme.fg("muted", `  ${formatModelTableHeader()}`), 0, 0));
		}

		// Show visible slice of filtered models
		for (let i = startIndex; i < endIndex; i++) {
			const item = this.filteredModels[i];
			if (!item) continue;

			const isSelected = i === this.selectedIndex;
			const isCurrent = modelsAreEqual(this.currentModel, item.model);
			const prefix = isSelected ? "→ " : "  ";
			const checkmark = isCurrent ? theme.fg("success", " ✓") : "";
			const line = `${prefix}${formatModelTableRow(item, this.vercelReleaseDates)}${checkmark}`;

			this.listContainer.addChild(new Text(isSelected ? theme.fg("accent", line) : line, 0, 0));
		}

		// Add scroll indicator if needed
		if (startIndex > 0 || endIndex < this.filteredModels.length) {
			const scrollInfo = theme.fg("muted", `  (${this.selectedIndex + 1}/${this.filteredModels.length})`);
			this.listContainer.addChild(new Text(scrollInfo, 0, 0));
		}

		// Show error message or "no results" if empty
		if (this.errorMessage) {
			// Show error in red
			const errorLines = this.errorMessage.split("\n");
			for (const line of errorLines) {
				this.listContainer.addChild(new Text(theme.fg("error", line), 0, 0));
			}
		} else if (this.filteredModels.length === 0) {
			this.listContainer.addChild(new Text(theme.fg("muted", "  No matching models"), 0, 0));
		} else {
			const selected = this.filteredModels[this.selectedIndex];
			this.listContainer.addChild(new Spacer(1));
			this.listContainer.addChild(
				new Text(theme.fg("muted", `  ${selected.provider}/${selected.id} · ${selected.model.name}`), 0, 0),
			);
		}
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();
		if (kb.matches(keyData, "tui.input.tab")) {
			if (this.scopedModelItems.length > 0) {
				const nextScope: ModelScope = this.scope === "all" ? "scoped" : "all";
				this.setScope(nextScope);
				if (this.scopeHintText) {
					this.scopeHintText.setText(this.getScopeHintText());
				}
			}
			return;
		}
		// Up arrow - wrap to bottom when at top
		if (kb.matches(keyData, "tui.select.up")) {
			if (this.filteredModels.length === 0) return;
			this.selectedIndex = this.selectedIndex === 0 ? this.filteredModels.length - 1 : this.selectedIndex - 1;
			this.updateList();
		}
		// Down arrow - wrap to top when at bottom
		else if (kb.matches(keyData, "tui.select.down")) {
			if (this.filteredModels.length === 0) return;
			this.selectedIndex = this.selectedIndex === this.filteredModels.length - 1 ? 0 : this.selectedIndex + 1;
			this.updateList();
		}
		// Enter
		else if (kb.matches(keyData, "tui.select.confirm")) {
			const selectedModel = this.filteredModels[this.selectedIndex];
			if (selectedModel) {
				this.handleSelect(selectedModel.model);
			}
		}
		// Escape or Ctrl+C
		else if (kb.matches(keyData, "tui.select.cancel")) {
			this.onCancelCallback();
		}
		// Pass everything else to search input
		else {
			this.searchInput.handleInput(keyData);
			this.filterModels(this.searchInput.getValue());
		}
	}

	private handleSelect(model: Model<any>): void {
		// Save as new default
		this.settingsManager.setDefaultModelAndProvider(model.provider, model.id);
		this.onSelectCallback(model);
	}

	getSearchInput(): Input {
		return this.searchInput;
	}
}
