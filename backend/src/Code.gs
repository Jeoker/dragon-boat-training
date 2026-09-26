function doGet(event) {
  return handleDragonBoatRequest_("GET", event || {});
}

function doPost(event) {
  return handleDragonBoatRequest_("POST", event || {});
}

function handleDragonBoatRequest_(method, event) {
  var requestId = createDragonBoatRequestId_();

  try {
    var request = parseDragonBoatRequest_(method, event);
    requestId = request.request_id;
    var routes = dragonBoatRoutes_();
    var route = Object.prototype.hasOwnProperty.call(routes, request.action) ? routes[request.action] : null;
    if (!route) {
      throw dragonBoatRequestError_("UNSUPPORTED_ACTION", "The requested action is not available.");
    }
    if (route.methods.indexOf(method) < 0) {
      throw dragonBoatRequestError_(
        "METHOD_NOT_ALLOWED",
        "This action must be sent as a " + route.methods.join(" or ") + " request."
      );
    }
    validateDragonBoatInputTypes_(request);
    return dragonBoatSuccess_(route.handle(request), requestId);
  } catch (error) {
    if (error && error.isDragonBoatRequestError) {
      return dragonBoatError_(
        error.code,
        error.message,
        error.retryable === true,
        requestId
      );
    }

    return dragonBoatError_(
      "INTERNAL_ERROR",
      "The service could not complete the request.",
      true,
      requestId
    );
  }
}

// One allowlist owns routing and HTTP methods. Lazy handlers also let the
// isolated bridge build expose its probe without loading business storage.
function dragonBoatRoutes_() {
  var routes = {};
  function add(names, method, handle) {
    names.split(" ").forEach(function (name) { routes[name] = { methods: method.split(" "), handle: handle }; });
  }
  add("health", "GET POST", function () { return dragonBoatHealth_(); });
  add("bootstrap", "GET", function (r) { return withDragonBoatScriptLock_(function () { return publicBootstrap_(r); }); });
  add("members", "GET", function (r) { return publicMembers_(r); });
  add("practice", "GET", function (r) { return publicPractice_(r); });
  add("historySeasons", "GET", function (r) { return publicHistorySeasons_(r); });
  add("seasonHistory", "GET", function (r) { return publicSeasonHistory_(r); });
  add("archivedPractice", "GET", function (r) { return publicArchivedPractice_(r); });
  add("signup signupByCoach updateSignup updateSignupByCoach cancelSignup cancelSignupByCoach", "POST", function (r) { return mutateSignup_(r); });
  add("updateMember restoreMemberName setMemberStatus", "POST", function (r) { return mutateMember_(r); });
  add("listSeasonMembers", "POST", function (r) { return listSeasonMembers_(r); });
  add("getMemberWorkspace", "POST", function (r) { return getMemberWorkspace_(r); });
  add("getSeatingWorkspace", "POST", function (r) { return getSeatingWorkspace_(r); });
  add("saveSeatPlanDraft", "POST", function (r) { return saveSeatPlanDraft_(r); });
  add("publishSeatPlan", "POST", function (r) { return publishSeatPlan_(r); });
  add("getArchiveManagement", "POST", function (r) { return getArchiveManagement_(r); });
  add("retrySeasonArchive", "POST", function (r) { return retrySeasonArchive_(r); });
  add("appendHistoryCorrection", "POST", function (r) { return appendHistoryCorrection_(r); });
  add("listManagementAudit", "POST", function (r) { return listManagementAudit_(r); });
  add("coachLogin", "POST", function (r) { return coachLogin_(r); });
  add("coachLogout", "POST", function (r) { return coachLogout_(r); });
  add("coachBootstrap", "POST", function (r) { return withDragonBoatScriptLock_(function () { return coachBootstrap_(r); }); });
  add("coachConnectivityWrite", "POST", function (r) { return coachConnectivityWrite_(r); });
  add("cloudflareBridgeProbe", "POST", function (r) { return cloudflareBridgeProbe_(r); });
  if (typeof cloudflareReadFormResponses_ === "function") {
    add("cloudflareReadFormResponses", "POST", function (r) { return cloudflareReadFormResponses_(r); });
  }
  add("getSeasonManagement", "POST", function (r) { return withDragonBoatScriptLock_(function () { return getSeasonManagement_(r); }); });
  add("createSeason", "POST", function (r) { return createSeason_(r); });
  add("validateSeasonBinding", "POST", function (r) { return validateSeasonBindingAction_(r); });
  add("initializeSeason", "POST", function (r) { return initializeSeason_(r); });
  add("retrySeasonSync", "POST", function (r) { return retrySeasonSync_(r); });
  add("previewPracticeChange", "POST", function (r) { return previewPracticeChange_(r); });
  add("updateTrainingWeek", "POST", function (r) { return updateTrainingWeek_(r); });
  add("setDefaultSeason updateSeasonSchedule updatePractice cancelPractice updateScheduleTemplates confirmTrainingWeek publishTrainingWeek createPractice publishAdditionalPractice", "POST", function (r) { return manageSchedule_(r); });
  return routes;
}

function validateDragonBoatInputTypes_(request) {
  // Validate types without rewriting the values: historical request digests
  // depend on the exact accepted JSON representation.
  ["season_version", "settings_version", "week_version", "practice_version", "signup_version",
    "member_version", "seat_plan_version", "published_revision", "history_version"].forEach(function (key) {
    if (request[key] !== undefined && !isRequestInteger_(request[key], 0, Number.MAX_SAFE_INTEGER)) {
      throw dragonBoatRequestError_("INVALID_REQUEST", "A non-negative integer " + key + " is required.");
    }
  });
  if (request.known_roster_version !== undefined && request.known_roster_version !== -1 &&
      !isRequestInteger_(request.known_roster_version, 0, Number.MAX_SAFE_INTEGER)) {
    throw dragonBoatRequestError_("INVALID_REQUEST", "known_roster_version must be an integer, or -1 when unknown.");
  }
  ["include_current_view", "acknowledge_preference_mismatch"].forEach(function (key) {
    if (request[key] !== undefined && typeof request[key] !== "boolean") {
      throw dragonBoatRequestError_("INVALID_REQUEST", key + " must be a boolean.");
    }
  });
  ["season_id", "practice_id", "week_id", "member_id"].forEach(function (key) {
    if (key === "season_id" && request.action === "bootstrap" && request[key] === "") return;
    if (request[key] !== undefined) requireRequestString_(request, key, 8, 128);
  });
}

function dragonBoatHealth_() {
  return {
    service: DRAGON_BOAT_SERVICE_NAME_,
    service_version: DRAGON_BOAT_SERVICE_VERSION_,
    status: "available"
  };
}

function parseDragonBoatRequest_(method, event) {
  var input;

  if (method === "GET") {
    input = event.parameter || {};
  } else {
    var body = event.postData && event.postData.contents;
    if (!body) {
      throw dragonBoatRequestError_("INVALID_REQUEST", "A JSON request body is required.");
    }

    try {
      input = JSON.parse(body);
    } catch (error) {
      throw dragonBoatRequestError_("INVALID_JSON", "The request body is not valid JSON.");
    }
  }

  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw dragonBoatRequestError_("INVALID_REQUEST", "The request must be a JSON object.");
  }

  var action = typeof input.action === "string" ? input.action.trim() : "";
  if (!action && method === "GET") {
    action = "health";
  }
  if (!action) {
    throw dragonBoatRequestError_("INVALID_REQUEST", "An action is required.");
  }

  var requestId = typeof input.request_id === "string" ? input.request_id.trim() : "";
  if (!requestId && input.request_id === undefined && method === "GET") {
    requestId = createDragonBoatRequestId_();
  }
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(requestId)) {
    throw dragonBoatRequestError_("INVALID_REQUEST_ID", "The request identifier is invalid.");
  }

  var request = {};
  Object.keys(input).forEach(function (key) {
    request[key] = input[key];
  });
  request.action = action;
  request.request_id = requestId;
  return request;
}

function dragonBoatSuccess_(data, requestId) {
  return dragonBoatJson_({
    ok: true,
    data: data,
    meta: dragonBoatMeta_(requestId)
  });
}

function dragonBoatRequestError_(code, message, retryable) {
  var error = new Error(message);
  error.code = code;
  error.retryable = retryable === true;
  error.isDragonBoatRequestError = true;
  return error;
}

function dragonBoatError_(code, message, retryable, requestId) {
  return dragonBoatJson_({
    ok: false,
    error: {
      code: code,
      message: message,
      retryable: retryable
    },
    meta: dragonBoatMeta_(requestId)
  });
}

function dragonBoatMeta_(requestId) {
  return {
    contract_version: DRAGON_BOAT_CONTRACT_VERSION_,
    server_time: new Date().toISOString(),
    request_id: requestId
  };
}

function createDragonBoatRequestId_() {
  return Utilities.getUuid().replace(/-/g, "_");
}

function dragonBoatJson_(payload) {
  return ContentService
    .createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}
