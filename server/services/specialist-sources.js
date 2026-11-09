// Curated primary publishers. Feeds are polled by the existing scheduler.
module.exports = {
  "physical-ai-lerobot": {
    "label": "LeRobot · Robotics releases",
    "description": "LeRobot 机器人学习框架官方版本更新",
    "homepage": "https://github.com/huggingface/lerobot",
    "feed": "https://github.com/huggingface/lerobot/releases.atom",
    "kind": "release",
    "context": "Robotics · LeRobot"
  },
  "physical-ai-isaaclab": {
    "label": "Isaac Lab · Robotics releases",
    "description": "Isaac Lab 机器人仿真与训练官方版本更新",
    "homepage": "https://github.com/isaac-sim/IsaacLab",
    "feed": "https://github.com/isaac-sim/IsaacLab/releases.atom",
    "kind": "release",
    "context": "Robotics · Isaac Lab"
  },
  "physical-ai-ros-community": {
    "label": "ROS Planet · Robotics community",
    "description": "ROS 开发者博客聚合；社区讨论不等于已验证的应用落地",
    "homepage": "https://planet.ros.org",
    "feed": "https://planet.ros.org/rss20.xml",
    "kind": "community",
    "context": "Robotics community"
  },
  "education-oatutor": {
    "label": "OATutor · AI education releases",
    "description": "开放自适应辅导系统的官方版本更新",
    "homepage": "https://github.com/CAHLR/OATutor",
    "feed": "https://github.com/CAHLR/OATutor/releases.atom",
    "kind": "release",
    "context": "AI education · OATutor"
  },
  "education-deeptutor": {
    "label": "DeepTutor · AI education releases",
    "description": "个性化 AI 辅导项目的官方版本更新",
    "homepage": "https://github.com/HKUDS/DeepTutor",
    "feed": "https://github.com/HKUDS/DeepTutor/releases.atom",
    "kind": "release",
    "context": "AI education · DeepTutor"
  },
  "education-openedx-community": {
    "label": "Open edX · AI education community",
    "description": "Open edX 社区最新讨论中包含 AI、LLM 或智能辅导的内容；并非完整论坛归档",
    "homepage": "https://discuss.openedx.org",
    "feed": "https://discuss.openedx.org/latest.rss",
    "kind": "community",
    "context": "Education community · Open edX"
  }
};
