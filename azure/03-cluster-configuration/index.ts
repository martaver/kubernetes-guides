import * as azure from "@pulumi/azure";
import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import * as tls from "@pulumi/tls";
import { config } from "./config";

const name = pulumi.getProject();

// Create an SSH public key that will be used by the Kubernetes cluster.
// Note: We create one here to simplify the demo, but a production
// deployment would probably pass an existing key in as a variable.
const sshPublicKey = new tls.PrivateKey(`${name}-sshKey`, {
    algorithm: "RSA",
    rsaBits: 4096,
}).publicKeyOpenssh;

// Create the AKS cluster.
const cluster = new azure.containerservice.KubernetesCluster(`${name}`, {
    resourceGroupName: config.resourceGroupName,
    agentPoolProfiles: [{
        name: "performant",
        count: 3,
        vmSize: "Standard_DS4_v2",
        osType: "Linux",
        osDiskSizeGb: 30,
        vnetSubnetId: config.subnetId,
    }, {
        name: "standard",
        count: 2,
        vmSize: "Standard_B2s",
        osType: "Linux",
        osDiskSizeGb: 30,
        vnetSubnetId: config.subnetId,
    }],
    dnsPrefix: name,
    enablePodSecurityPolicy: true,
    linuxProfile: {
        adminUsername: "aksuser",
        sshKey: {
            keyData: sshPublicKey,
        },
    },
    servicePrincipal: {
        clientId: config.adClientAppId,
        clientSecret: config.adClientAppSecret,
    },
    kubernetesVersion: "1.14.8",
    roleBasedAccessControl: {
        enabled: true,
        azureActiveDirectory: {
            clientAppId: config.adClientAppId,
            serverAppId: config.adServerAppId,
            serverAppSecret: config.adServerAppSecret,
        },
    },
    networkProfile: {
        networkPlugin: "azure",
        dnsServiceIp: "10.2.2.254",
        serviceCidr: "10.2.2.0/24",
        dockerBridgeCidr: "172.17.0.1/16",
    },
    addonProfile: {
        omsAgent: {
            enabled: true,
            logAnalyticsWorkspaceId: config.logAnalyticsWorkspaceId,
        },
    },
});

// Create a static public IP for the Service LoadBalancer.
const staticAppIp = new azure.network.PublicIp(`${name}-staticAppIp`, {
    resourceGroupName: cluster.nodeResourceGroup,
    allocationMethod: "Static",
}).ipAddress;

// Export the cluster details.
export const kubeconfig = cluster.kubeConfigRaw;
export const kubeconfigAdmin = cluster.kubeAdminConfigRaw;
export const clusterId = cluster.id;
export const clusterName = cluster.name;

// Define a k8s provider instance of the cluster.
// Use admin config to get enough permissions for role binding.
const provider = new k8s.Provider(`${name}-aks`, {
    kubeconfig: cluster.kubeAdminConfigRaw,
});

const adminRole = new k8s.rbac.v1.ClusterRoleBinding("pulumi-admins", {
    subjects: [{
        apiGroup: "rbac.authorization.k8s.io",
        kind: "Group",
        name: config.adGroupAdmins,
    }],
    roleRef: {
        apiGroup: "rbac.authorization.k8s.io",
        kind: "ClusterRole",
        name: "cluster-admin",
    },
}, { provider });

// Create Kubernetes namespaces.
const clusterSvcsNamespace = new k8s.core.v1.Namespace("cluster-svcs", undefined, { provider, dependsOn: [adminRole] });
export const clusterSvcsNamespaceName = clusterSvcsNamespace.metadata.name;

const appSvcsNamespace = new k8s.core.v1.Namespace("app-svcs", undefined, { provider, dependsOn: [adminRole] });
export const appSvcsNamespaceName = appSvcsNamespace.metadata.name;

const appNamespace = new k8s.core.v1.Namespace("apps", undefined, { provider, dependsOn: [adminRole] });
export const appNamespaceName = appNamespace.metadata.name;

// Create a resource quota in the apps namespace.
const quotaAppNamespace = new k8s.core.v1.ResourceQuota("apps", {
    metadata: {namespace: appNamespaceName},
    spec: {
        hard: {
            cpu: "20",
            memory: "1Gi",
            pods: "10",
            replicationcontrollers: "20",
            resourcequotas: "1",
            services: "5",
        },
    },
}, { provider });

// Create a limited role for the `pulumi:devs` to use in the apps namespace.
const devsGroupRole = new k8s.rbac.v1.Role("pulumi-devs",
    {
        metadata: { namespace: appNamespaceName },
        rules: [
            {
                apiGroups: ["", "apps"],
                resources: ["pods", "services", "deployments", "replicasets", "persistentvolumeclaims"],
                verbs: ["get", "list", "watch", "create", "update", "delete"],
            },
        ],
    },
    { provider },
);

// Bind the `pulumi:devs` RBAC group to the new, limited role.
const devsGroupRoleBinding = new k8s.rbac.v1.RoleBinding("pulumi-devs", {
    metadata: { namespace: appNamespaceName },
    subjects: [{
        kind: "Group",
        name: config.adGroupDevs,
    }],
    roleRef: {
        apiGroup: "rbac.authorization.k8s.io",
        kind: "Role",
        name: devsGroupRole.metadata.name,
    },
}, { provider });
