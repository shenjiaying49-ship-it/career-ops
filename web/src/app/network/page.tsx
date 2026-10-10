import type { Metadata } from "next";
import { NetworkDashboard } from "@/components/network/network-dashboard";

export const metadata: Metadata = {
  title: "我的人脉网络",
  description: "查看人脉网络，以及遇到不同事情时可以联系谁。",
};
export const dynamic = "force-dynamic";
export default function NetworkPage() { return <NetworkDashboard />; }
