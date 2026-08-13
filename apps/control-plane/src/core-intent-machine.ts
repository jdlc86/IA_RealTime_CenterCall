export type CoreWorkflow =
  | "ROUTING"
  | "CREATE_RESERVATION"
  | "CANCEL_RESERVATION"
  | "QUERY_RESERVATION"
  | "BUSINESS_INFO"
  | "MARKETING_CONSENT"
  | "CLOSING";

export type BusinessInfoTopic =
  | "MENU"
  | "HOURS"
  | "LOCATION"
  | "SERVICES"
  | "GENERAL_INFO";

export type CoreIntent = Exclude<CoreWorkflow, "ROUTING">;
export type ClosingResponse = "CONFIRM" | "REJECT";

export type CoreIntentRequest = {
  intent: CoreIntent;
  businessInfoTopics?: BusinessInfoTopic[];
  auxiliary?: boolean;
  closingResponse?: ClosingResponse;
};

export type CoreIntentState = {
  workflow: CoreWorkflow;
  suspendedWorkflow: Exclude<CoreWorkflow, "ROUTING" | "BUSINESS_INFO" | "CLOSING"> | null;
  businessInfoTopics: BusinessInfoTopic[];
};

export type CoreTransitionReason =
  | "INITIAL_ROUTE"
  | "CONTINUE_CURRENT"
  | "WORKFLOW_SWITCH"
  | "AUXILIARY_INFO_ENTER"
  | "AUXILIARY_INFO_RETURN"
  | "CLOSE";

export type CoreTransition = {
  previous: CoreIntentState;
  next: CoreIntentState;
  reason: CoreTransitionReason;
};

export function initialCoreIntentState(): CoreIntentState {
  return {
    workflow: "ROUTING",
    suspendedWorkflow: null,
    businessInfoTopics: [],
  };
}

function uniqueTopics(topics: BusinessInfoTopic[] | undefined): BusinessInfoTopic[] {
  if (!topics?.length) return ["GENERAL_INFO"];
  return [...new Set(topics)];
}

function isSuspendableWorkflow(
  workflow: CoreWorkflow,
): workflow is Exclude<CoreWorkflow, "ROUTING" | "BUSINESS_INFO" | "CLOSING"> {
  return workflow === "CREATE_RESERVATION"
    || workflow === "CANCEL_RESERVATION"
    || workflow === "QUERY_RESERVATION"
    || workflow === "MARKETING_CONSENT";
}

/** Pure top-level conversation state machine. */
export function transitionCoreIntent(
  current: CoreIntentState,
  request: CoreIntentRequest,
): CoreTransition {
  if (current.workflow === "CLOSING") {
    return { previous: current, next: current, reason: "CLOSE" };
  }

  if (request.intent === "CLOSING") {
    return {
      previous: current,
      next: { workflow: "CLOSING", suspendedWorkflow: null, businessInfoTopics: [] },
      reason: "CLOSE",
    };
  }

  if (request.intent === "BUSINESS_INFO") {
    const topics = uniqueTopics(request.businessInfoTopics);
    if (request.auxiliary === true && isSuspendableWorkflow(current.workflow)) {
      return {
        previous: current,
        next: {
          workflow: "BUSINESS_INFO",
          suspendedWorkflow: current.workflow,
          businessInfoTopics: topics,
        },
        reason: "AUXILIARY_INFO_ENTER",
      };
    }

    if (current.workflow === "BUSINESS_INFO" && current.suspendedWorkflow !== null) {
      return {
        previous: current,
        next: {
          workflow: "BUSINESS_INFO",
          suspendedWorkflow: current.suspendedWorkflow,
          businessInfoTopics: topics,
        },
        reason: "CONTINUE_CURRENT",
      };
    }

    return {
      previous: current,
      next: { workflow: "BUSINESS_INFO", suspendedWorkflow: null, businessInfoTopics: topics },
      reason: current.workflow === "ROUTING" ? "INITIAL_ROUTE" : current.workflow === "BUSINESS_INFO" ? "CONTINUE_CURRENT" : "WORKFLOW_SWITCH",
    };
  }

  if (current.workflow === request.intent) {
    return {
      previous: current,
      next: { ...current, businessInfoTopics: [] },
      reason: "CONTINUE_CURRENT",
    };
  }

  return {
    previous: current,
    next: { workflow: request.intent, suspendedWorkflow: null, businessInfoTopics: [] },
    reason: current.workflow === "ROUTING" ? "INITIAL_ROUTE" : "WORKFLOW_SWITCH",
  };
}

export function returnFromAuxiliaryBusinessInfo(current: CoreIntentState): CoreTransition {
  if (current.workflow !== "BUSINESS_INFO" || current.suspendedWorkflow === null) {
    return { previous: current, next: current, reason: "CONTINUE_CURRENT" };
  }

  return {
    previous: current,
    next: {
      workflow: current.suspendedWorkflow,
      suspendedWorkflow: null,
      businessInfoTopics: [],
    },
    reason: "AUXILIARY_INFO_RETURN",
  };
}
