const LICENSES = [
  {
    key: "ABCD-1234-EFGH-5678",
    owner: "Romel Gonzaga",
    plan: "Professional",
    expires: "2026-12-31",
  },
  {
    key: "BEABOTS-0002-AAAA-BBBB",
    owner: "Encoders",
    plan: "Standard",
    expires: "2026-12-31",
  },
  {
    key: "BEABOTS-0003-CCCC-DDDD",
    owner: "Nephro",
    plan: "Enterprise",
    expires: "2027-12-31",
  },
];

// Edit this block for each release, then deploy the Worker.
// Upload this exact installer before publishing these release details.
// These values take precedence over any old Cloudflare release variables.
const RELEASE = {
  version: "4.0.7",
  minimum_version: "4.0.5",
  mandatory: true,
  notes: [],
  download: "https://github.com/rgonzaga19/beacon_automation/releases/download/Beabots/Beabots_Setup_v4.0.5.exe",
  // SHA-256 of Output/Beabots_Setup_v4.0.6.exe. Replace after every rebuild.
  sha256: "56ECFADAEE7C25E1E245B295FBC462A5C51B975575C26F9CEDBD1919EBA41CC9",
};

function releaseConfig(env) {
  const version = RELEASE.version;
  const minimumVersion = RELEASE.minimum_version;
  const enforce = RELEASE.mandatory;
  const info = {
    version,
    minimum_version: minimumVersion,
    mandatory: enforce,
    notes: RELEASE.notes,
    download: RELEASE.download,
    sha256: String(RELEASE.sha256 || "").trim().toLowerCase(),
  };
  let valid = /^\d+\.\d+\.\d+$/.test(version) &&
    /^\d+\.\d+\.\d+$/.test(minimumVersion) &&
    /^[a-f0-9]{64}$/.test(info.sha256) &&
    compareVersions(version, minimumVersion) >= 0;
  try {
    valid = valid && new URL(info.download).protocol === "https:";
  } catch {
    valid = false;
  }
  return { info, enforce, valid };
}

// -----------------------------------------------------------------------------
// HTTP helpers
// -----------------------------------------------------------------------------

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Cache-Control": "no-store",
};

function jsonResponse(body, status = 200) {
  return Response.json(body, {
    status,
    headers: CORS_HEADERS,
  });
}

function normalizeVersion(value) {
  const match = String(value || "")
    .trim()
    .match(/^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/i);

  if (!match) {
    return null;
  }

  return [
    Number(match[1]),
    Number(match[2]),
    Number(match[3]),
  ];
}

function compareVersions(left, right) {
  const leftParts = normalizeVersion(left);
  const rightParts = normalizeVersion(right);

  if (!leftParts || !rightParts) {
    return null;
  }

  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] > rightParts[index]) {
      return 1;
    }

    if (leftParts[index] < rightParts[index]) {
      return -1;
    }
  }

  return 0;
}

function requiresUpdate(appVersion, minimumVersion) {
  const comparison = compareVersions(
    appVersion,
    minimumVersion,
  );

  // Missing or invalid versions are treated as unsupported.
  return comparison === null || comparison < 0;
}

function updateRequiredResponse(info) {
  return jsonResponse({
    valid: false,
    code: "UPDATE_REQUIRED",
    reason: "Update required",
    minimum_version: info.minimum_version,
    latest_version: info.version,
    download: info.download,
  });
}

function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

// -----------------------------------------------------------------------------
// Cloudflare Worker
// -----------------------------------------------------------------------------

export default {
  async fetch(request, env = {}) {
    const url = new URL(request.url);
    const release = releaseConfig(env);

    // Handle CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: CORS_HEADERS,
      });
    }

    // Return the latest application update information.
    if (
      request.method === "GET" &&
      url.pathname === "/update"
    ) {
      if (!release.valid) {
        return jsonResponse({
          code: "UPDATE_NOT_CONFIGURED",
          reason: "A verified update release has not been configured.",
        }, 503);
      }
      return jsonResponse(release.info);
    }

    // license.py currently sends its validation request
    // to the Worker root.
    if (
      request.method === "POST" &&
      url.pathname === "/"
    ) {
      let body;

      try {
        body = await request.json();
      } catch {
        return jsonResponse(
          {
            valid: false,
            code: "INVALID_REQUEST",
            reason: "The request body must be valid JSON.",
          },
          400,
        );
      }

      const licenseKey = String(
        body?.license || "",
      ).trim();

      const appVersion = String(
        body?.app_version || "",
      ).trim();

      if (!licenseKey) {
        return jsonResponse(
          {
            valid: false,
            code: "LICENSE_REQUIRED",
            reason: "A license key is required.",
          },
          400,
        );
      }

      const license = LICENSES.find(
        (entry) => entry.key === licenseKey,
      );

      if (!license) {
        return jsonResponse({
          valid: false,
          code: "INVALID_LICENSE",
          reason: "Invalid license.",
        });
      }

      // A license remains valid for its entire expiration date.
      if (license.expires < todayUtc()) {
        return jsonResponse({
          valid: false,
          code: "LICENSE_EXPIRED",
          reason: "License expired.",
          expires: license.expires,
        });
      }

      if (
        release.enforce && release.valid &&
        requiresUpdate(appVersion, release.info.minimum_version)
      ) {
        return updateRequiredResponse(release.info);
      }

      return jsonResponse({
        valid: true,
        owner: license.owner,
        plan: license.plan,
        expires: license.expires,
      });
    }

    if (request.method === "GET") {
      return jsonResponse(
        {
          valid: false,
          code: "NOT_FOUND",
          reason: "Not Found",
        },
        404,
      );
    }

    return jsonResponse(
      {
        valid: false,
        code: "METHOD_NOT_ALLOWED",
        reason: "Method Not Allowed",
      },
      405,
    );
  },
};
