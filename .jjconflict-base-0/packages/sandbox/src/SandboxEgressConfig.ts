export type SandboxEgressConfig = {
	env?: Record<string, string>;
	httpProxy?: string;
	httpsProxy?: string;
	noProxy?: string | string[];
	caCertPem?: string;
	caCertPath?: string;
	secretBindings?: Record<string, string>;
};
