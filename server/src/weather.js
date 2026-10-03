const API_KEY = process.env.OPENWEATHER_API_KEY;

if (!API_KEY) {
  console.warn(
    "[sarjy] OPENWEATHER_API_KEY is not set — get a free key at " +
      "https://home.openweathermap.org/users/sign_up and add it to server/.env"
  );
}

export const weatherToolDefinition = {
  type: "function",
  function: {
    name: "get_weather",
    description:
      "Get current weather conditions for a named city or place. Use this " +
      "whenever the user asks about weather, temperature, rain, etc. Always " +
      "ask the user for a location first if they didn't give one.",
    parameters: {
      type: "object",
      properties: {
        location: {
          type: "string",
          description: "City name, e.g. 'Dubai' or 'San Francisco, CA'",
        },
      },
      required: ["location"],
    },
  },
};

export async function getWeather(location) {
  if (!API_KEY) {
    return { error: "Weather lookup is not configured (missing API key)." };
  }

  try {
    const res = await fetch(
      `https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(
        location
      )}&units=metric&appid=${API_KEY}`
    );

    if (res.status === 404) {
      return { error: `Could not find a location matching "${location}".` };
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(
        `[sarjy] weather request failed: ${res.status} ${res.statusText} — ${body.slice(0, 300)}`
      );
      return { error: "Weather service is unavailable right now." };
    }

    const data = await res.json();
    return {
      location: [data.name, data.sys?.country].filter(Boolean).join(", "),
      temperature_c: data.main?.temp,
      feels_like_c: data.main?.feels_like,
      humidity_pct: data.main?.humidity,
      wind_mps: data.wind?.speed,
      conditions: data.weather?.[0]?.description,
    };
  } catch (err) {
    // Log the REAL cause server-side (network error, DNS failure, etc.) —
    // the object returned to the model stays a generic message on purpose,
    // per the guardrail instruction not to let it invent data when a tool
    // fails, but that means the real error is invisible unless logged here.
    console.error(`[sarjy] getWeather("${location}") threw:`, err);
    return { error: `Weather lookup failed: ${err.message}` };
  }
}
