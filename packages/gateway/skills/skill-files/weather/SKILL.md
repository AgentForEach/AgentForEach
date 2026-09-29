---
id: weather
name: Weather
description: Get current weather and forecasts for any location worldwide
category: information
credentials: []
---

# Weather Skill

Use the Open-Meteo API (free, no API key required).

## Get Current Weather

1. Geocode the location:
   ```
   exec: ["curl", "-s", "https://geocoding-api.open-meteo.com/v1/search?name=LOCATION&count=1"]
   ```
   Extract `latitude` and `longitude` from the first result in `.results[0]`.

2. Fetch current weather:
   ```
   exec: ["curl", "-s", "https://api.open-meteo.com/v1/forecast?latitude=LAT&longitude=LON&current=temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m&timezone=auto"]
   ```

3. Format the response with temperature, conditions, humidity, and wind speed.

## Get Forecast

Same geocoding step, then:
```
exec: ["curl", "-s", "https://api.open-meteo.com/v1/forecast?latitude=LAT&longitude=LON&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=auto&forecast_days=DAYS"]
```

Default to 5 days if the user doesn't specify.

## Weather Codes

| Code | Condition |
|------|-----------|
| 0 | Clear sky |
| 1-3 | Partly cloudy |
| 45-48 | Fog |
| 51-55 | Drizzle |
| 61-65 | Rain |
| 71-75 | Snow |
| 80-82 | Rain showers |
| 95 | Thunderstorm |

## Tips

- Replace spaces in location names with `+` or `%20` in the URL.
- Use `jq` to extract specific fields if the JSON response is large.
- The API returns temperature in Celsius by default. Add `&temperature_unit=fahrenheit` for Fahrenheit.
