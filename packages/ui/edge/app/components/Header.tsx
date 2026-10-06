import {
  Container, Group, rem, Tabs, Text, Title,
} from '@mantine/core';
import {
  IconDashboard, IconDevices, IconLock, IconNetwork, IconPlug,
} from '@tabler/icons-react';
import React from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

const iconStyle = { width: rem(18), height: rem(18) };

const mainLinks = [
  { link: '/', label: 'Dashboard', icon: <IconDashboard style={iconStyle} /> },
  { link: '/devices', label: '设备控制', icon: <IconPlug style={iconStyle} /> },
  { link: '/nodes', label: 'Node 管理', icon: <IconDevices style={iconStyle} /> },
  { link: '/upstream', label: '上游连接', icon: <IconNetwork style={iconStyle} /> },
  { link: '/auth', label: '认证设置', icon: <IconLock style={iconStyle} /> },
];

export function Header() {
  const nowRoute = useLocation().pathname;
  const navigate = useNavigate();

  const mainItems = mainLinks.map((item) => (
    <Tabs.Tab key={item.link} value={item.link} mr="xs" leftSection={item.icon}>
      <Text visibleFrom="md">{item.label}</Text>
    </Tabs.Tab>
  ));

  return (
    <header>
      <Container size="xl">
        <Group justify="space-between" h="100%" px="md">
          <Title order={3}>Edge Dashboard</Title>
          <Group h="100%" gap={0} visibleFrom="sm">
            <Tabs
              variant="pills"
              value={nowRoute}
              onChange={(value) => navigate(value!)}
            >
              <Tabs.List>{mainItems}</Tabs.List>
            </Tabs>
          </Group>
        </Group>
      </Container>
    </header>
  );
}
