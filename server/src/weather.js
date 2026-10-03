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
  try {
    const geoRes = await fetch(
      `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(
        location
      )}&count=1&language=en&format=json`
    );
    if (!geoRes.ok) {
      const body = await geoRes.text().catch(() => "");
      console.error(
        `[sarjy] geocoding request failed: ${geoRes.status} ${geoRes.statusText} — ${body.slice(0, 300)}`
      );
      return { error: "Weather service is unavailable right now." };
    }
    const geo = await geoRes.json();
    const place = geo.results?.[0];
    if (!place) {
      return { error: `Could not find a location matching "${location}".` };
    }

    const weatherRes = await fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${place.latitude}&longitude=${place.longitude}` +
        `&current=temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m,weather_code` +
        `&temperature_unit=celsius&wind_speed_unit=kmh`
    );
    if (!weatherRes.ok) {
      const body = await weatherRes.text().catch(() => "");
      console.error(
        `[sarjy] forecast request failed: ${weatherRes.status} ${weatherRes.statusText} — ${body.slice(0, 300)}`
      );
      return { error: "Weather service is unavailable right now." };
    }
    const data = await weatherRes.json();

    return {
      location: [place.name, place.admin1, place.country]
        .filter(Boolean)
        .join(", "),
      temperature_c: data.current.temperature_2m,
      feels_like_c: data.current.apparent_temperature,
      humidity_pct: data.current.relative_humidity_2m,
      wind_kmh: data.current.wind_speed_10m,
      weather_code: data.current.weather_code,
    };
  } catch (err) {
    // Log the REAL cause server-side (network error, DNS failure, fetch
    // not being defined on an old Node runtime, etc.) — the object we
    // return to the model stays a generic message on purpose, per the
    // guardrail instruction not to let it invent data, but that means the
    // real error is invisible unless we log it here too.
    console.error(`[sarjy] getWeather("${location}") threw:`, err);
    return { error: `Weather lookup failed: ${err.message}` };
  }
}
