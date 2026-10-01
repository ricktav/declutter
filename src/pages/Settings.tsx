import { useEffect, useState } from "react";
import { trpc } from "@/providers/trpc";
import { Button } from "@/components/ui/button";
import { DEFAULT_FLOORS } from "@/components/RoomPicker";
import { AddressAutocomplete } from "@/components/AddressAutocomplete";
import { FloorsEditor } from "@/components/FloorsEditor";
import { fetchParcelInfo, kadastraleKaartUrl } from "@/lib/pdok";
import { Plug, CheckCircle2, XCircle, Loader2, Trash2, Columns2, MessageSquare, Home, Plus, Pencil, Check, X } from "lucide-react";

const PRESETS = [
  { label: "xAI Grok", baseUrl: "https://api.x.ai/v1" },
  { label: "OpenAI", baseUrl: "https://api.openai.com/v1" },
  { label: "Ollama (local)", baseUrl: "http://localhost:11434/v1" },
  { label: "DeepSeek", baseUrl: "https://api.deepseek.com/v1" },
];

export default function SettingsPage() {
  const utils = trpc.useUtils();
  const current = trpc.settings.get.useQuery();

  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("");
  const [visionModel, setVisionModel] = useState("");
  const [testResult, setTestResult] = useState<{ ok: boolean; models?: string[]; error?: string } | null>(null);
  const [testing, setTesting] = useState(false);
  const [promptResult, setPromptResult] = useState<{ ok: boolean; reply?: string; ms?: number; error?: string } | null>(null);
  const [promptTesting, setPromptTesting] = useState(false);

  // Provider B (A/B comparison)
  const [bBaseUrl, setBBaseUrl] = useState("");
  const [bApiKey, setBApiKey] = useState("");
  const [bModel, setBModel] = useState("");
  const [bTestResult, setBTestResult] = useState<{ ok: boolean; models?: string[]; error?: string } | null>(null);
  const [bTesting, setBTesting] = useState(false);
  const [bPromptResult, setBPromptResult] = useState<{ ok: boolean; reply?: string; ms?: number; error?: string } | null>(null);
  const [bPromptTesting, setBPromptTesting] = useState(false);

  useEffect(() => {
    if (current.data) {
      setBaseUrl(current.data.settings.llmBaseUrl ?? current.data.env?.llmBaseUrl ?? "");
      setModel(current.data.settings.llmModel ?? current.data.env?.llmModel ?? "");
      setVisionModel(current.data.settings.llmVisionModel ?? current.data.env?.llmVisionModel ?? "");
      setBBaseUrl(current.data.settings.llm2BaseUrl ?? current.data.env2?.llm2BaseUrl ?? "");
      setBModel(current.data.settings.llm2Model ?? current.data.env2?.llm2Model ?? "");
    }
  }, [current.data]);

  const save = trpc.settings.update.useMutation({
    onSuccess: () => utils.settings.get.invalidate(),
  });
  const test = trpc.settings.testConnection.useMutation();
  const testPrompt = trpc.settings.testPrompt.useMutation();

  const runTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await Promise.race([
        test.mutateAsync({
          llmBaseUrl: baseUrl || undefined,
          llmApiKey: apiKey || undefined,
        }),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Timed out after 25s — the provider did not answer. Check the base URL.")), 26_000)),
      ]);
      setTestResult(res);
    } catch (e) {
      setTestResult({ ok: false, error: (e as Error).message });
    }
    setTesting(false);
  };

  const runBTest = async () => {
    setBTesting(true);
    setBTestResult(null);
    try {
      const res = await Promise.race([
        test.mutateAsync({
          llmBaseUrl: bBaseUrl || undefined,
          llmApiKey: bApiKey || undefined,
          provider: "2",
        }),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Timed out after 25s — the provider did not answer.")), 26_000)),
      ]);
      setBTestResult(res);
    } catch (e) {
      setBTestResult({ ok: false, error: (e as Error).message });
    }
    setBTesting(false);
  };

  const runPromptTest = async () => {
    setPromptTesting(true);
    setPromptResult(null);
    try {
      const res = await Promise.race([
        testPrompt.mutateAsync({
          llmBaseUrl: baseUrl || undefined,
          llmApiKey: apiKey || undefined,
          model,
          provider: "1",
        }),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Timed out after 30s — the provider did not reply. Check base URL, key and model.")), 31_000)),
      ]);
      setPromptResult(res);
    } catch (e) {
      setPromptResult({ ok: false, error: (e as Error).message });
    }
    setPromptTesting(false);
  };

  const runBPromptTest = async () => {
    setBPromptTesting(true);
    setBPromptResult(null);
    try {
      const res = await Promise.race([
        testPrompt.mutateAsync({
          llmBaseUrl: bBaseUrl || undefined,
          llmApiKey: bApiKey || undefined,
          model: bModel,
          provider: "2",
        }),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Timed out after 30s — the provider did not reply.")), 31_000)),
      ]);
      setBPromptResult(res);
    } catch (e) {
      setBPromptResult({ ok: false, error: (e as Error).message });
    }
    setBPromptTesting(false);
  };

  const sourceLabel: Record<string, string> = {
    settings: "Settings (this page)",
    env: ".env file",
    kimi: "Kimi platform",
    none: "not configured",
  };

  return (
    <div className="max-w-2xl mx-auto px-6 py-8">
      <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
      <p className="text-sm text-muted-foreground mt-1">
        LLM provider for triage, chat, object detection and wiki enhancement.
      </p>
      {current.isError && (
        <div className="mt-4 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-[12px] text-amber-900">
          Could not load provider info: {String((current.error as { message?: string })?.message ?? current.error) ?? "server error"}. Fields below show
          what is saved in the app; restart the dev server if you just edited <span className="font-data">.env</span>.
        </div>
      )}

      <div className="mt-4 rounded-lg border border-border bg-white px-4 py-3 flex items-center gap-2 text-[13px]">
        <Plug className="h-4 w-4 text-muted-foreground" />
        Active provider:{" "}
        <b>{sourceLabel[current.data?.source ?? "none"] ?? current.data?.source}</b>
        {current.data?.settings.llmApiKeyMasked && (
          <span className="font-data text-[11px] text-muted-foreground ml-auto">
            key {current.data.settings.llmApiKeyMasked}
          </span>
        )}
      </div>

      <div className="mt-6 rounded-lg border border-border bg-white p-4 space-y-4">
        <div>
          <div className="micro-label text-muted-foreground mb-1.5">Preset</div>
          <div className="flex gap-1.5 flex-wrap">
            {PRESETS.map((p) => (
              <button
                key={p.label}
                onClick={() => setBaseUrl(p.baseUrl)}
                className={`rounded-full px-3 py-1 text-[12px] transition-colors ${
                  baseUrl === p.baseUrl
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted hover:bg-accent"
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>

        <label className="block">
          <span className="micro-label text-muted-foreground">Base URL</span>
          <input
            className="mt-1 w-full rounded-md border border-input px-3 py-2 text-[13px] font-data"
            placeholder="https://api.x.ai/v1"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
          />
        </label>

        <label className="block">
          <span className="micro-label text-muted-foreground">API key</span>
          <input
            className="mt-1 w-full rounded-md border border-input px-3 py-2 text-[13px] font-data"
            placeholder={
              (current.data?.settings.llmApiKeyMasked ?? current.data?.env?.llmApiKeyMasked)
                ? `••• ${current.data?.settings.llmApiKeyMasked ?? current.data?.env?.llmApiKeyMasked} (leave empty to keep)`
                : "xai-… / sk-… / any string for Ollama"
            }
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
          />
        </label>

        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" className="h-8 text-[12px]" onClick={runTest} disabled={testing}>
            {testing ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : <Plug className="h-3.5 w-3.5 mr-1" />}
            Test connection
          </Button>
          {testResult && (
            testResult.ok ? (
              <span className="flex items-center gap-1 text-[12px] text-emerald-700">
                <CheckCircle2 className="h-3.5 w-3.5" /> {testResult.models?.length ?? 0} models available
              </span>
            ) : (
              <span className="flex items-center gap-1 text-[12px] text-destructive">
                <XCircle className="h-3.5 w-3.5" /> {testResult.error}
              </span>
            )
          )}
        </div>

        {testResult?.ok && testResult.models && (
          <div>
            <div className="micro-label text-muted-foreground mb-1.5">Available models (click to use)</div>
            <div className="flex flex-wrap gap-1.5 max-h-40 overflow-y-auto">
              {testResult.models.map((m) => (
                <button
                  key={m}
                  onClick={() => {
                    setModel(m);
                    if (!visionModel) setVisionModel(m);
                  }}
                  className={`rounded px-2 py-1 text-[11px] font-data transition-colors ${
                    model === m ? "bg-primary text-primary-foreground" : "bg-muted hover:bg-accent"
                  }`}
                >
                  {m}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="grid sm:grid-cols-2 gap-3">
          <label className="block">
            <span className="micro-label text-muted-foreground">Chat model</span>
            <input
              className="mt-1 w-full rounded-md border border-input px-3 py-2 text-[13px] font-data"
              placeholder="grok-4.7"
              value={model}
              onChange={(e) => setModel(e.target.value)}
            />
          </label>
          <label className="block">
            <span className="micro-label text-muted-foreground">Vision model (photos)</span>
            <input
              className="mt-1 w-full rounded-md border border-input px-3 py-2 text-[13px] font-data"
              placeholder="same as chat if empty"
              value={visionModel}
              onChange={(e) => setVisionModel(e.target.value)}
            />
          </label>
        </div>

        <div className="flex items-center gap-2 pt-1">
          <Button
            size="sm"
            className="h-8 text-[12px]"
            disabled={save.isPending || !baseUrl || !model}
            onClick={() =>
              save.mutate({
                llmBaseUrl: baseUrl,
                llmApiKey: apiKey || undefined,
                llmModel: model,
                llmVisionModel: visionModel || undefined,
              })
            }
          >
            Save
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-8 text-[12px]"
            disabled={promptTesting || !model}
            title="Send a real generation request and show the reply + latency — works with providers that don't expose /models"
            onClick={runPromptTest}
          >
            {promptTesting ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : <MessageSquare className="h-3.5 w-3.5 mr-1" />}
            Test with prompt
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-8 text-[12px] text-muted-foreground"
            onClick={() => {
              save.mutate({ clear: true });
              setApiKey("");
            }}
          >
            <Trash2 className="h-3.5 w-3.5 mr-1" /> Clear saved settings
          </Button>
        </div>
        {promptResult && (
          promptResult.ok ? (
            <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-[12px] text-emerald-800">
              Replied <b className="font-data">“{promptResult.reply}”</b> in <span className="font-data">{promptResult.ms} ms</span> — the model
              generated a real response with these settings.
            </div>
          ) : (
            <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-800">
              {promptResult.error}
            </div>
          )
        )}
      </div>

      <p className="text-[12px] text-muted-foreground mt-4">
        Precedence: this page → <span className="font-data">.env</span> <span className="font-data">LLM_*</span> variables →
        Kimi platform gateway. Settings are stored in <span className="font-data">settings.json</span> next to the app
        (not committed to git).
      </p>

      {/* Provider B */}
      <div className="mt-8 flex items-center gap-2">
        <Columns2 className="h-4 w-4 text-violet-600" />
        <h2 className="text-sm font-semibold">Provider B — A/B comparison</h2>
      </div>
      <p className="text-[12px] text-muted-foreground mt-1">
        Optional second provider. With both configured, every inbox capture gets an{" "}
        <b>A/B</b> button that runs the same triage prompt on both models side by side. Provider A keeps doing all
        the real work — B is for comparison only.
      </p>

      <div className="mt-3 rounded-lg border border-violet-200 bg-white p-4 space-y-4">
        {current.data?.env2 && !current.data.settings.llm2BaseUrl && (
          <div className="rounded bg-violet-50 border border-violet-200 px-3 py-2 text-[12px] text-violet-900">
            Currently using <span className="font-data">LLM2_*</span> from <span className="font-data">.env</span>
            {current.data.env2.llm2BaseUrl && <> ({current.data.env2.llm2BaseUrl})</>}.
          </div>
        )}
        <div className="flex gap-1.5 flex-wrap">
          {PRESETS.map((p) => (
            <button
              key={p.label}
              onClick={() => setBBaseUrl(p.baseUrl)}
              className={`rounded-full px-3 py-1 text-[12px] transition-colors ${
                bBaseUrl === p.baseUrl
                  ? "bg-violet-600 text-white"
                  : "bg-muted hover:bg-accent"
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>

        <label className="block">
          <span className="micro-label text-muted-foreground">Base URL</span>
          <input
            className="mt-1 w-full rounded-md border border-input px-3 py-2 text-[13px] font-data"
            placeholder="https://openrouter.ai/api/v1"
            value={bBaseUrl}
            onChange={(e) => setBBaseUrl(e.target.value)}
          />
        </label>

        <label className="block">
          <span className="micro-label text-muted-foreground">API key</span>
          <input
            className="mt-1 w-full rounded-md border border-input px-3 py-2 text-[13px] font-data"
            placeholder={
              (current.data?.settings.llm2ApiKeyMasked ?? current.data?.env2?.llm2ApiKeyMasked)
                ? `••• ${current.data?.settings.llm2ApiKeyMasked ?? current.data?.env2?.llm2ApiKeyMasked} (leave empty to keep)`
                : "sk-or-…"
            }
            type="password"
            value={bApiKey}
            onChange={(e) => setBApiKey(e.target.value)}
          />
        </label>

        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" className="h-8 text-[12px]" onClick={runBTest} disabled={bTesting}>
            {bTesting ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : <Plug className="h-3.5 w-3.5 mr-1" />}
            Test connection
          </Button>
          {bTestResult && (
            bTestResult.ok ? (
              <span className="flex items-center gap-1 text-[12px] text-emerald-700">
                <CheckCircle2 className="h-3.5 w-3.5" /> {bTestResult.models?.length ?? 0} models available
              </span>
            ) : (
              <span className="flex items-center gap-1 text-[12px] text-destructive">
                <XCircle className="h-3.5 w-3.5" /> {bTestResult.error}
              </span>
            )
          )}
        </div>

        {bTestResult?.ok && bTestResult.models && (
          <div>
            <div className="micro-label text-muted-foreground mb-1.5">Available models (click to use)</div>
            <div className="flex flex-wrap gap-1.5 max-h-40 overflow-y-auto">
              {bTestResult.models.map((m) => (
                <button
                  key={m}
                  onClick={() => setBModel(m)}
                  className={`rounded px-2 py-1 text-[11px] font-data transition-colors ${
                    bModel === m ? "bg-violet-600 text-white" : "bg-muted hover:bg-accent"
                  }`}
                >
                  {m}
                </button>
              ))}
            </div>
          </div>
        )}

        <label className="block">
          <span className="micro-label text-muted-foreground">Model</span>
          <input
            className="mt-1 w-full rounded-md border border-input px-3 py-2 text-[13px] font-data"
            placeholder="e.g. openai/gpt-5"
            value={bModel}
            onChange={(e) => setBModel(e.target.value)}
          />
        </label>

        <div className="flex items-center gap-2 pt-1">
          <Button
            size="sm"
            className="h-8 text-[12px] bg-violet-600 hover:bg-violet-700"
            disabled={save.isPending || !bBaseUrl || !bModel}
            onClick={() =>
              save.mutate({
                llm2BaseUrl: bBaseUrl,
                llm2ApiKey: bApiKey || undefined,
                llm2Model: bModel,
              })
            }
          >
            Save Provider B
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-8 text-[12px] border-violet-300 text-violet-700 hover:bg-violet-50"
            disabled={bPromptTesting || !bModel}
            title="Send a real generation request and show the reply + latency"
            onClick={runBPromptTest}
          >
            {bPromptTesting ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : <MessageSquare className="h-3.5 w-3.5 mr-1" />}
            Test with prompt
          </Button>
        </div>
        {bPromptResult && (
          bPromptResult.ok ? (
            <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-[12px] text-emerald-800">
              Replied <b className="font-data">“{bPromptResult.reply}”</b> in <span className="font-data">{bPromptResult.ms} ms</span> — the model
              generated a real response with these settings.
            </div>
          ) : (
            <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-800">
              {bPromptResult.error}
            </div>
          )
        )}
      </div>
      {/* Houses & locations */}
      <div className="mt-8 flex items-center gap-2">
        <Home className="h-4 w-4 text-emerald-700" />
        <h2 className="text-sm font-semibold">Houses & locations</h2>
      </div>
      <p className="text-[12px] text-muted-foreground mt-1">
        Location context lives on items: <b>house → floor → room</b>. Areas stay the topic (computers, kitchen, …),
        locations say where the thing physically is.
      </p>
      <div className="mt-3 rounded-lg border border-border bg-white p-4 space-y-3">
        <HousesSection />
      </div>
    </div>
  );
}

type HouseRowData = {
  id: number;
  name: string;
  address: string | null;
  lat: number | null;
  lng: number | null;
  floors: string[] | null;
  itemCount: number;
  parcelId?: string | null;
  parcelAreaM2?: number | null;
};

function HouseRow({ house }: { house: HouseRowData }) {
  const utils = trpc.useUtils();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(house.name);
  const [address, setAddress] = useState(house.address ?? "");
  const [lat, setLat] = useState(house.lat != null ? String(house.lat) : "");
  const [lng, setLng] = useState(house.lng != null ? String(house.lng) : "");
  const [bagId, setBagId] = useState<string | null>(null);
  const [parcel, setParcel] = useState<{ parcelId: string; parcelAreaM2: number | null } | null>(
    house.parcelId ? { parcelId: house.parcelId, parcelAreaM2: house.parcelAreaM2 ?? null } : null,
  );
  const [floors, setFloors] = useState<string[]>(house.floors ?? []);

  const update = trpc.houses.update.useMutation({
    onSuccess: () => {
      utils.houses.list.invalidate();
      setEditing(false);
    },
  });
  const remove = trpc.houses.remove.useMutation({ onSuccess: () => utils.houses.list.invalidate() });

  if (editing) {
    return (
      <div className="rounded-md border border-primary px-3 py-2.5 space-y-2">
        <div className="grid sm:grid-cols-2 gap-2">
          <input
            className="rounded-md border border-input px-2 py-1.5 text-[13px]"
            placeholder="House name"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <AddressAutocomplete
            value={address}
            onChange={setAddress}
            onSelect={async (s) => {
              setAddress(s.label);
              if (s.lat != null) setLat(String(s.lat));
              if (s.lng != null) setLng(String(s.lng));
              setBagId(s.bagId);
              const info = await fetchParcelInfo(s).catch(() => null);
              setParcel(info);
            }}
          />
          <input
            className="rounded-md border border-input px-2 py-1.5 text-[13px] font-data"
            placeholder="Latitude"
            value={lat}
            onChange={(e) => setLat(e.target.value)}
          />
          <input
            className="rounded-md border border-input px-2 py-1.5 text-[13px] font-data"
            placeholder="Longitude"
            value={lng}
            onChange={(e) => setLng(e.target.value)}
          />
        </div>
        <label className="block">
          <span className="micro-label text-muted-foreground">Floors</span>
          <div className="mt-0.5">
            <FloorsEditor value={floors} onChange={setFloors} />
          </div>
        </label>
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="ghost" className="h-7 text-[12px]" onClick={() => setEditing(false)}>
            <X className="h-3.5 w-3.5 mr-1" /> Cancel
          </Button>
          <Button
            size="sm"
            className="h-7 text-[12px]"
            disabled={!name.trim() || update.isPending}
            onClick={() =>
              update.mutate({
                id: house.id,
                name: name.trim(),
                address: address.trim() || null,
                lat: lat.trim() ? Number(lat) : null,
                lng: lng.trim() ? Number(lng) : null,
                floors: floors.length > 0 ? floors : null,
                bagId: bagId || undefined,
                parcelId: parcel?.parcelId || undefined,
                parcelAreaM2: parcel?.parcelAreaM2 ?? undefined,
              })
            }
          >
            {update.isPending ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <Check className="h-3.5 w-3.5 mr-1" />}
            Save
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-start gap-3 rounded-md border border-border px-3 py-2">
      <div className="flex-1 min-w-0">
        <div className="text-[13px] font-medium">
          {house.name}
          <span className="ml-2 font-data text-[11px] text-muted-foreground">{house.itemCount} items</span>
        </div>
        {house.address && <div className="text-[12px] text-muted-foreground">{house.address}</div>}
        {house.lat != null && house.lng != null && (
          <a
            className="text-[11px] text-primary hover:underline font-data"
            href={`https://www.openstreetmap.org/?mlat=${house.lat}&mlon=${house.lng}#map=19/${house.lat}/${house.lng}`}
            target="_blank"
            rel="noreferrer"
          >
            {house.lat.toFixed(5)}, {house.lng.toFixed(5)} — map ↗
          </a>
        )}
        {house.parcelId && (
          <a
            className="text-[11px] text-primary hover:underline font-data"
            href={kadastraleKaartUrl(house.address ?? house.parcelId)}
            target="_blank"
            rel="noreferrer"
          >
            {house.parcelId}
            {house.parcelAreaM2 != null ? ` · ${house.parcelAreaM2}m²` : ""} — parcel ↗
          </a>
        )}
        <div className="font-data text-[11px] text-muted-foreground mt-0.5">
          floors: {(house.floors ?? DEFAULT_FLOORS).join(", ")}
        </div>
      </div>
      <button
        className="text-muted-foreground hover:text-primary mt-0.5"
        title="Edit house"
        onClick={() => setEditing(true)}
      >
        <Pencil className="h-3.5 w-3.5" />
      </button>
      <button
        className="text-muted-foreground hover:text-destructive mt-0.5"
        title="Delete house (items are unassigned, not deleted)"
        onClick={() => remove.mutate({ id: house.id })}
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

function HousesSection() {
  const utils = trpc.useUtils();
  const houses = trpc.houses.list.useQuery();
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [lat, setLat] = useState("");
  const [lng, setLng] = useState("");
  const create = trpc.houses.create.useMutation({
    onSuccess: () => {
      utils.houses.list.invalidate();
      setName(""); setAddress(""); setLat(""); setLng("");
    },
  });

  return (
    <>
      {(houses.data ?? []).map((h) => (
        <HouseRow key={h.id} house={h} />
      ))}
      <div className="grid sm:grid-cols-2 gap-2">
        <input
          className="rounded-md border border-input px-2 py-1.5 text-[13px]"
          placeholder="House name (e.g. Home, Office)"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <input
          className="rounded-md border border-input px-2 py-1.5 text-[13px]"
          placeholder="Address (street, city)"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
        />
        <input
          className="rounded-md border border-input px-2 py-1.5 text-[13px] font-data"
          placeholder="Latitude (optional)"
          value={lat}
          onChange={(e) => setLat(e.target.value)}
        />
        <input
          className="rounded-md border border-input px-2 py-1.5 text-[13px] font-data"
          placeholder="Longitude (optional)"
          value={lng}
          onChange={(e) => setLng(e.target.value)}
        />
      </div>
      <div>
        <Button
          size="sm"
          variant="outline"
          className="h-8 text-[12px]"
          disabled={!name.trim() || create.isPending}
          onClick={() =>
            create.mutate({
              name: name.trim(),
              address: address.trim() || undefined,
              lat: lat.trim() ? Number(lat) : undefined,
              lng: lng.trim() ? Number(lng) : undefined,
            })
          }
        >
          <Plus className="h-3.5 w-3.5 mr-1" /> Add house
        </Button>
      </div>
    </>
  );
}
