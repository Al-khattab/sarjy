// Open-Meteo: free, no API key, generous rate limits — matches the PRD's
// requirement that a reviewer can open the deployed URL "without special
// setup." Two calls: geocode the place name, then fetch current conditions.

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
    // Explicit error object, never silently empty data — the system prompt
    // instructs the model to state the failure rather than invent a number.
    return { error: `Weather lookup failed: ${err.message}` };
  }
}
